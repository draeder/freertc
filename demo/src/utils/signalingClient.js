import {
  generateRandomPair,
  signMessage,
  verifyMessage,
  encryptMessageWithMeta,
  decryptMessageWithMeta,
} from 'unsea'

// One P-256 keypair per browser session — persisted in sessionStorage.
const _sessionKeysPromise = (async () => {
  try {
    if (typeof window !== 'undefined') {
      const stored = window.sessionStorage.getItem('unsea.signalingClient')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed?.priv && parsed?.epriv) return parsed
      }
    }
    const keys = await generateRandomPair()
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('unsea.signalingClient', JSON.stringify({
        pub: keys.pub, priv: keys.priv, epub: keys.epub, epriv: keys.epriv,
      }))
    }
    return keys
  } catch {
    return await generateRandomPair()
  }
})()

// Backoff config for reconnect
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30000
const BACKOFF_FACTOR = 1.5
const DATA_PING_MS = 3000
const DATA_PONG_TIMEOUT_MS = 12000
const SIGNAL_PING_MS = 1000
const RELAY_RETRY_INTERVAL_MS = 2000
const ANSWER_BURST_COOLDOWN_MS = 3000
const ANSWER_BURST_DELAYS_MS = [200, 800, 2000]
const SDP_DEDUP_WINDOW_MS = 15000

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

const ALT_ICE_SERVERS = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
]

export function createSignalingClient(options = {}) {
  const {
    peerId: initialPeerId,
    networkId,
    signalUrl,
    iceServers: configuredIceServers,
    capabilities = {},
    auth,
    autoConnect = true,
    onLog,
    onRegistered,
    onBootstrap,
    onIncomingRelay,
    onNegotiationFailure,
    onConnectionStateChange,
    onStatusChange,
    onDataMessage,
  } = options

  if (!initialPeerId || !networkId || !signalUrl) {
    throw new Error('peerId, networkId, and signalUrl are required')
  }

  const mesh = {
    buckets: {},
    connections: new Map(),
    bootstrapCandidates: [],

    addCandidate(candidate) {
      const existing = mesh.bootstrapCandidates.findIndex((c) => c.peerId === candidate.peerId)
      if (existing >= 0) {
        mesh.bootstrapCandidates[existing] = { ...candidate, localSeenAt: Date.now() }
      } else {
        mesh.bootstrapCandidates.push({ ...candidate, localSeenAt: Date.now() })
      }
    },

    getFreshCandidates(maxAgeMs = 10 * 60_000) {
      const cutoff = Date.now() - maxAgeMs
      return mesh.bootstrapCandidates.filter((c) => c.localSeenAt > cutoff)
    },

    markLive(peerId) {
      const conn = mesh.connections.get(peerId)
      if (conn) conn.lastSeen = Date.now()
    },

    markDead(peerId) {
      const conn = mesh.connections.get(peerId)
      if (conn) {
        conn.state = 'dead'
      }
    },
  }

  // ── Signaling client state ────────────────────────────────────────────────
  let ws = null
  let peerId = initialPeerId
  let registered = false
  let backoffMs = BACKOFF_BASE_MS
  let reconnectTimer = null
  let advertiseHeartbeatTimer = null
  let keepaliveTimer = null
  let intentionalClose = false
  let stoppedByUser = false
  let onConnectionStateChangeCb = onConnectionStateChange
  let lastBootstrapCountLogged = null

  // Pending ICE candidate queues — keyed by peerId.
  const pendingCandidates = new Map()
  // Serialize incoming offer processing per remote peer.
  const offerProcessingQueues = new Map()
  // Track scheduled answer retransmit bursts per remote peer.
  const answerBurstTimers = new Map()
  // Ensure only one remote answer is being applied at a time per peer.
  const answerApplyInFlight = new Map()
  // Keep the newest answer if it arrives before local state is ready.
  const pendingAnswers = new Map()
  // Track recent offer/answer SDPs per peer to avoid duplicate processing storms.
  const recentOfferSdp = new Map()
  const recentAnswerSdp = new Map()
  // One-time alternate STUN fallback when default profile yields no candidates.
  const altStunFallbackTried = new Set()

  // PSP session_id per remote peer (generated when initiating, adopted when receiving).
  const sessionIds = new Map()

  // Remote pub keys learned from peer_list hints and incoming relay messages.
  // peerId → { pub: string, epub: string }
  const remotePubKeys = new Map()
  const preferredIceServers = Array.isArray(configuredIceServers) && configuredIceServers.length > 0
    ? configuredIceServers
    : DEFAULT_ICE_SERVERS

  function resolveIceServers(overrideIceServers = null) {
    return Array.isArray(overrideIceServers) && overrideIceServers.length > 0
      ? overrideIceServers
      : preferredIceServers
  }

  function notifyNegotiationFailure(details) {
    try {
      onNegotiationFailure?.({ ...details, ts: Date.now() })
    } catch {}
  }

  function getOrCreateSessionId(remotePeerId) {
    if (!sessionIds.has(remotePeerId)) {
      sessionIds.set(remotePeerId, generateMessageId())
    }
    return sessionIds.get(remotePeerId)
  }

  function setSessionId(remotePeerId, sessionId) {
    if (sessionId) sessionIds.set(remotePeerId, sessionId)
  }

  function rotateSessionId(remotePeerId) {
    const sid = generateMessageId()
    sessionIds.set(remotePeerId, sid)
    return sid
  }

  function clearAnswerBurst(remotePeerId) {
    const timers = answerBurstTimers.get(remotePeerId)
    if (!timers) return
    for (const timerId of timers) {
      clearTimeout(timerId)
    }
    answerBurstTimers.delete(remotePeerId)
  }

  function startAnswerBurst(remotePeerId, pc, sendRelay, answer, force = false) {
    const entry = mesh.connections.get(remotePeerId)
    if (!entry) return

    const now = Date.now()
    if (!force && now - (entry.lastAnswerBurstAt ?? 0) < ANSWER_BURST_COOLDOWN_MS) {
      return
    }

    entry.lastAnswerBurstAt = now
    clearAnswerBurst(remotePeerId)

    if (
      pc.signalingState === 'closed' ||
      pc.connectionState === 'connected' ||
      pc.connectionState === 'closed'
    ) {
      return
    }

    entry.lastAnswerSentAt = Date.now()
    sendRelay('answer', answer)

    const scheduled = []
    for (const delayMs of ANSWER_BURST_DELAYS_MS) {
      const timerId = setTimeout(() => {
        const current = mesh.connections.get(remotePeerId)
        if (!current) return
        if (
          pc.signalingState === 'closed' ||
          pc.connectionState === 'connected' ||
          pc.connectionState === 'closed'
        ) {
          return
        }
        current.lastAnswerSentAt = Date.now()
        sendRelay('answer', answer)
      }, delayMs)
      scheduled.push(timerId)
    }

    answerBurstTimers.set(remotePeerId, scheduled)
  }

  function log(msg) {
    onLog?.(msg)
  }

  function setStatus(status) {
    onStatusChange?.(status)
    log(`[signal] status: ${status}`)
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }

  function generateMessageId() {
    const bytes = new Uint8Array(8)
    const webCrypto = globalThis.window?.crypto ?? globalThis.crypto
    webCrypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }

  async function waitForIceGatheringComplete(pc, timeoutMs = 4000) {
    if (!pc || pc.iceGatheringState === 'complete') return
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { pc.removeEventListener('icegatheringstatechange', onChange) } catch {}
        resolve()
      }
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
      const timer = setTimeout(done, timeoutMs)
      try { pc.addEventListener('icegatheringstatechange', onChange) } catch { done() }
      onChange()
    })
  }

  function pspEnvelope(type, opts = {}) {
    return {
      psp_version: '1.0',
      type,
      network:    networkId,
      from:       peerId,
      to:         opts.to         ?? null,
      session_id: opts.session_id ?? null,
      message_id: generateMessageId(),
      timestamp:  Date.now(),
      ttl_ms:     opts.ttl_ms    ?? null,
      reply_to:   opts.reply_to  ?? null,
      body:       opts.body      ?? {},
    }
  }

  async function relaySignal(toPeerId, type, body) {
    if (!registered) {
      log('[signal] not registered yet')
      return
    }
    if (type === 'offer' || type === 'answer' || type === 'renegotiate') {
      log(`[signal] sending ${type} to ${toPeerId}`)
    }

    send(pspEnvelope(type, {
      to:         toPeerId,
      session_id: getOrCreateSessionId(toPeerId),
      body,
    }))
  }

  function stopAdvertiseHeartbeat() {
    clearInterval(advertiseHeartbeatTimer)
    advertiseHeartbeatTimer = null
  }

  function stopKeepalive() {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }

  function startAdvertiseHeartbeat() {
    stopAdvertiseHeartbeat()
    advertiseHeartbeatTimer = setInterval(async () => {
      if (!registered) return
      const myKeys = await _sessionKeysPromise
      // Re-announce to refresh TTL in the server's peer registry.
      send(pspEnvelope('announce', {
        ttl_ms: 30000,
        body: { capabilities, hints: { wants_peers: true, pub: myKeys.pub, epub: myKeys.epub } },
      }))
    }, 12000)
  }

  function startKeepalive() {
    stopKeepalive()
    keepaliveTimer = setInterval(() => {
      if (!registered) return
      send(pspEnvelope('ping', { body: { nonce: generateMessageId() } }))
    }, SIGNAL_PING_MS)
  }

  function scheduleReconnect(openSocket, closeCode) {
    if (closeCode === 1000 || stoppedByUser) return
    log(`[signal] reconnecting in ${backoffMs}ms`)
    reconnectTimer = setTimeout(() => {
      openSocket()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS)
  }

  function closeAllPeerConnections() {
    for (const [remotePeerId, entry] of mesh.connections.entries()) {
      try {
        entry.connection?.close()
      } catch {}
      clearAnswerBurst(remotePeerId)
      answerApplyInFlight.delete(remotePeerId)
      offerProcessingQueues.delete(remotePeerId)
      onConnectionStateChangeCb?.({ peerId: remotePeerId, state: 'closed', ts: Date.now() })
    }
  }

  function attachDataChannelHandlers(channel, remotePeerId, pc) {
    let keepaliveTimerId = null
    let lastPongAt    = Date.now()
    let lastPingSentAt = 0   // 0 = no ping in flight

    // Reset the pong clock the moment the tab becomes visible so the
    // throttled-timer gap doesn't look like a timeout.
    function onVisible() {
      if (typeof document === 'undefined' || document.hidden) return
      // Any ping that was sent while the tab was hidden can't have been
      // answered; don't count that gap as a missed pong.
      lastPingSentAt = 0
      lastPongAt = Date.now()
    }

    const entry = mesh.connections.get(remotePeerId)
    if (entry) entry.channel = channel

    channel.onopen = () => {
      log(`[webrtc] data channel open to ${remotePeerId}`)
      lastPongAt = Date.now()

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
        document.addEventListener('visibilitychange', onVisible)
      }

      const openEntry = mesh.connections.get(remotePeerId)
      if (openEntry) {
        openEntry.channel = channel
        openEntry.lastSeen = Date.now()
      }

      clearInterval(keepaliveTimerId)
      keepaliveTimerId = setInterval(() => {
        if (channel.readyState !== 'open') return

        // Browsers throttle timers in hidden tabs — don't falsely time out.
        if (typeof document !== 'undefined' && document.hidden) {
          lastPingSentAt = 0
          lastPongAt = Date.now()
          return
        }

        // Only consider a timeout if we sent a ping that hasn't been answered.
        const pingInFlight = lastPingSentAt > lastPongAt
        if (pingInFlight && Date.now() - lastPingSentAt > DATA_PONG_TIMEOUT_MS) {
          log(`[webrtc] data channel timeout to ${remotePeerId}; closing peer connection`)
          clearInterval(keepaliveTimerId)
          keepaliveTimerId = null
          try {
            channel.close()
          } catch {}
          try {
            pc.close()
          } catch {}
          mesh.markDead(remotePeerId)
          return
        }

        try {
          channel.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
          lastPingSentAt = Date.now()
        } catch {
          // Ignore transient send errors.
        }
      }, DATA_PING_MS)
    }

    channel.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        onDataMessage?.({ peerId: remotePeerId, data: event.data })
        return
      }

      if (msg?.type === 'ping') {
        try {
          channel.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
        } catch {
          // Ignore send failure.
        }
        return
      }

      if (msg?.type === 'pong') {
        lastPongAt = Date.now()
        lastPingSentAt = 0
        return
      }

      onDataMessage?.({ peerId: remotePeerId, data: event.data })
    }

    channel.onclose = () => {
      log(`[webrtc] data channel closed to ${remotePeerId}`)
      clearInterval(keepaliveTimerId)
      keepaliveTimerId = null
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
      const closedEntry = mesh.connections.get(remotePeerId)
      if (closedEntry?.channel === channel) closedEntry.channel = null
    }

    channel.onerror = (evt) => {
      const msg = evt?.error?.message ?? evt?.error ?? evt?.message ?? String(evt)
      log(`[webrtc] data channel error to ${remotePeerId}: ${msg}`)
    }
  }

  function createPeerConnection(remotePeerId, iceServers, sendRelay) {
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 4,
    })

    // Helps some browser stacks gather candidates more reliably for data-channel-only sessions.
    try { pc.addTransceiver('audio', { direction: 'recvonly' }) } catch {}

    mesh.connections.set(remotePeerId, {
      connection: pc,
      channel: null,
      state: 'connecting',
      lastSeen: Date.now(),
      lastRemoteOfferSdp: null,
      lastLocalAnswer: null,
      lastAppliedAnswerSdp: null,
      lastAnswerSentAt: 0,
      lastAnswerBurstAt: 0,
      localCandidateCount: 0,
      iceServers,
    })

    onConnectionStateChangeCb?.({ peerId: remotePeerId, state: 'connecting', ts: Date.now() })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const entry = mesh.connections.get(remotePeerId)
        if (entry) entry.localCandidateCount = (entry.localCandidateCount ?? 0) + 1
        log(`[webrtc] local candidate to ${remotePeerId}`)
        sendRelay('ice_candidate', {
          candidate: {
            candidate:     event.candidate.candidate,
            sdpMid:        event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        })
      } else {
        sendRelay('ice_end', {})
      }
    }

    pc.onicecandidateerror = (event) => {
      const code = event?.errorCode ?? 'unknown'
      const text = event?.errorText ?? 'unknown'
      const url = event?.url ?? 'n/a'
      log(`[webrtc] ice candidate error to ${remotePeerId}: code=${code} text=${text} url=${url}`)
    }

    pc.onconnectionstatechange = () => {
      log(`[webrtc] connection to ${remotePeerId}: ${pc.connectionState}`)
      const entry = mesh.connections.get(remotePeerId)
      if (entry) {
        entry.state = pc.connectionState
        entry.lastSeen = Date.now()
      }
      onConnectionStateChangeCb?.({ peerId: remotePeerId, state: pc.connectionState, ts: Date.now() })

      if (pc.connectionState === 'connected') {
        mesh.markLive(remotePeerId)
        clearAnswerBurst(remotePeerId)
      } else if (pc.connectionState === 'disconnected') {
        const entry = mesh.connections.get(remotePeerId)
        if (entry) entry.state = 'recovering'
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        mesh.markDead(remotePeerId)
      }

      if (pc.connectionState === 'closed') {
        if (pc.__offerRetryTimer) {
          clearInterval(pc.__offerRetryTimer)
          pc.__offerRetryTimer = null
        }
      }
    }

    pc.oniceconnectionstatechange = () => {
      log(`[webrtc] ice to ${remotePeerId}: ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'failed') {
        mesh.markDead(remotePeerId)
      }
    }

    pc.onicegatheringstatechange = () => {
      log(`[webrtc] ice gathering to ${remotePeerId}: ${pc.iceGatheringState}`)
    }

    pc.ondatachannel = (event) => {
      attachDataChannelHandlers(event.channel, remotePeerId, pc)
    }

    return pc
  }

  async function initiateWebRTCConnection(toPeerId, iceServers = null) {
    const priorEntry = mesh.connections.get(toPeerId)
    const prior = priorEntry?.connection

    // Don't dial if the data channel is already open.
    if (priorEntry?.channel?.readyState === 'open') {
      return prior
    }

    if (prior && prior.signalingState !== 'closed') {
      try {
        prior.close()
      } catch {}
      mesh.connections.delete(toPeerId)
    }

    const effectiveIceServers = resolveIceServers(iceServers)
    const pc = createPeerConnection(toPeerId, effectiveIceServers, (type, body) => {
      relaySignal(toPeerId, type, body)
    })

    const dc = pc.createDataChannel('mesh')
    attachDataChannelHandlers(dc, toPeerId, pc)

    // New dial attempt gets a fresh signaling session.
    const activeSessionId = rotateSessionId(toPeerId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // If an answer arrived before we reached have-local-offer, apply it now.
    const pendingAnswer = pendingAnswers.get(toPeerId)
    if (
      pendingAnswer?.sdp &&
      pendingAnswer?.sessionId === activeSessionId &&
      pc.signalingState === 'have-local-offer'
    ) {
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: pendingAnswer.sdp })
        const entry = mesh.connections.get(toPeerId)
        if (entry) entry.lastAppliedAnswerSdp = pendingAnswer.sdp
        recentAnswerSdp.set(toPeerId, { sdp: pendingAnswer.sdp, ts: Date.now() })
        pendingAnswers.delete(toPeerId)
        if (pc.__offerRetryTimer) {
          clearInterval(pc.__offerRetryTimer)
          pc.__offerRetryTimer = null
        }
        log(`[webrtc] applied queued answer from ${toPeerId}`)

        // Flush queued ICE candidates that may have arrived before answer apply.
        const queued = pendingCandidates.get(toPeerId) ?? []
        pendingCandidates.delete(toPeerId)
        for (const candidate of queued) {
          await pc.addIceCandidate(candidate).catch(() => {})
        }
      } catch (err) {
        log(`[webrtc] failed applying queued answer from ${toPeerId}: ${err}`)
      }
    }
    await waitForIceGatheringComplete(pc)

    relaySignal(toPeerId, 'offer', { sdp: pc.localDescription?.sdp ?? offer.sdp, trickle_ice: true })

    // If default profile yields zero candidates, try one alternate STUN profile.
    const candidateHealthTimer = setTimeout(() => {
      const entry = mesh.connections.get(toPeerId)
      const localCount = entry?.localCandidateCount ?? 0
      if (localCount > 0) return
      if (pc.remoteDescription) return
      if (pc.signalingState !== 'have-local-offer') return
      const alreadyTried = altStunFallbackTried.has(toPeerId)
      if (alreadyTried) return
      altStunFallbackTried.add(toPeerId)
      log(`[webrtc] no local ICE candidates for ${toPeerId}; retrying with alternate STUN profile`)
      try { pc.close() } catch {}
      mesh.connections.delete(toPeerId)
      clearInterval(retryTimer)
      initiateWebRTCConnection(toPeerId, ALT_ICE_SERVERS)
    }, 5000)

    let retries = 0
    const MAX_OFFER_RETRIES = 15 // 15 × 2s = 30s max, better with ping-queued relay
    const retryTimer = setInterval(() => {
      if (pc.signalingState === 'closed' || pc.remoteDescription) {
        clearInterval(retryTimer)
        clearTimeout(candidateHealthTimer)
        return
      }
      if (pc.signalingState !== 'have-local-offer') {
        clearInterval(retryTimer)
        clearTimeout(candidateHealthTimer)
        return
      }
      if (retries >= MAX_OFFER_RETRIES) {
        clearInterval(retryTimer)
        clearTimeout(candidateHealthTimer)
        log(`[webrtc] offer to ${toPeerId} timed out after ${MAX_OFFER_RETRIES} retries; giving up`)
        notifyNegotiationFailure({
          peerId: toPeerId,
          reason: 'offer_retries_exhausted',
          retryCount: retries,
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
        })
        try { pc.close() } catch {}
        mesh.markDead(toPeerId)
        return
      }
      retries += 1
      relaySignal(toPeerId, 'offer', { sdp: pc.localDescription?.sdp ?? offer.sdp, trickle_ice: true })
    }, RELAY_RETRY_INTERVAL_MS)

    pc.__offerRetryTimer = retryTimer
    return pc
  }

  async function handleIncomingOffer(fromPeerId, offer) {
    let queue = offerProcessingQueues.get(fromPeerId) ?? Promise.resolve()

    queue = queue
      .then(async () => {
        const sendRelay = (type, body) => {
          relaySignal(fromPeerId, type, body)
        }

        const existingEntry = mesh.connections.get(fromPeerId)

        // Already connected — just re-send our cached answer so the remote
        // peer's retry timer can stop; do NOT tear down the live connection.
        if (existingEntry?.channel?.readyState === 'open') {
          if (existingEntry.lastLocalAnswer) {
            sendRelay('answer', existingEntry.lastLocalAnswer)
          }
          return
        }

        // If the existing connection is dead/failed (but signalingState not yet
        // 'closed' because we never called pc.close() on failure), close it now
        // and start a fresh RTCPeerConnection. Reusing a failed pc causes ICE
        // re-gathering to run on a broken transport, which never recovers.
        const existing = existingEntry?.connection
        if (
          existing &&
          existing.signalingState !== 'closed' &&
          (existing.connectionState === 'failed' ||
            existing.connectionState === 'closed' ||
            existingEntry?.state === 'dead')
        ) {
          try { existing.close() } catch {}
          mesh.connections.delete(fromPeerId)
          clearAnswerBurst(fromPeerId)
          pendingCandidates.delete(fromPeerId)
          offerProcessingQueues.delete(fromPeerId)
        }

        const freshEntry = mesh.connections.get(fromPeerId)
        const pc =
          freshEntry?.connection && freshEntry.connection.signalingState !== 'closed'
            ? freshEntry.connection
            : createPeerConnection(fromPeerId, freshEntry?.iceServers ?? resolveIceServers(), sendRelay)

        const entry = mesh.connections.get(fromPeerId)
        const incomingOfferSdp = offer?.sdp ?? null
        const cachedAnswer = entry?.lastLocalAnswer ?? null
        const currentRemoteOfferSdp = entry?.lastRemoteOfferSdp ?? pc.remoteDescription?.sdp ?? null
        const now = Date.now()
        const recent = recentOfferSdp.get(fromPeerId)

        if (
          incomingOfferSdp &&
          recent?.sdp === incomingOfferSdp &&
          now - recent.ts < SDP_DEDUP_WINDOW_MS
        ) {
          if (cachedAnswer) {
            startAnswerBurst(fromPeerId, pc, sendRelay, cachedAnswer)
          }
          return
        }

        if (
          incomingOfferSdp &&
          cachedAnswer &&
          currentRemoteOfferSdp === incomingOfferSdp
        ) {
          // Duplicate offer for same SDP: do not renegotiate repeatedly.
          // Re-send cached answer at most once per cooldown window.
          const shouldResend = Date.now() - (entry?.lastAnswerSentAt ?? 0) > ANSWER_BURST_COOLDOWN_MS
          if (shouldResend) {
            entry.lastAnswerSentAt = Date.now()
            sendRelay('answer', cachedAnswer)
          }
          return
        }

        if (pc.signalingState === 'closed') return
        await pc.setRemoteDescription(offer)

        if (entry) {
          entry.lastRemoteOfferSdp = incomingOfferSdp
        }

        const queued = pendingCandidates.get(fromPeerId) ?? []
        pendingCandidates.delete(fromPeerId)
        for (const candidate of queued) {
          await pc.addIceCandidate(candidate).catch(() => {})
        }

        const answer = await pc.createAnswer()
        if (pc.signalingState === 'closed') return
        await pc.setLocalDescription(answer)
        await waitForIceGatheringComplete(pc)
        const finalAnswerSdp = pc.localDescription?.sdp ?? answer.sdp
        if (entry) {
          entry.lastLocalAnswer = { sdp: finalAnswerSdp }
        }
        if (incomingOfferSdp) {
          recentOfferSdp.set(fromPeerId, { sdp: incomingOfferSdp, ts: Date.now() })
        }
        startAnswerBurst(fromPeerId, pc, sendRelay, { sdp: finalAnswerSdp }, true)
      })
      .catch((err) => {
        log(`[webrtc] handleIncomingOffer failed: ${err}`)
      })

    offerProcessingQueues.set(fromPeerId, queue)
  }

  async function handleSignalingMessage(rawMsg) {
    const fromPeerId = rawMsg.from
    log(`[signal] incoming ${rawMsg.type} from ${fromPeerId}`)

    try { onIncomingRelay?.(rawMsg) } catch { /* never let app callback abort signaling */ }

    const msg = rawMsg

    const conn = mesh.connections.get(fromPeerId)
    if (
      !conn &&
      (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice_candidate' || msg.type === 'renegotiate')
    ) {
      onConnectionStateChangeCb?.({ peerId: fromPeerId, state: 'connecting', ts: Date.now() })
    }
    if (conn) {
      conn.lastSeen = Date.now()
      if (conn.state !== 'connected') conn.state = 'connecting'
    }

    switch (msg.type) {
      case 'offer':
        setSessionId(fromPeerId, msg.session_id)
        handleIncomingOffer(fromPeerId, { type: 'offer', sdp: msg.body.sdp }).catch((err) => {
          log(`[webrtc] handleIncomingOffer failed: ${err}`)
        })
        break

      case 'answer':
        if (conn?.connection) {
          const incomingAnswerSdp = msg.body?.sdp ?? null
          if (!incomingAnswerSdp) break
          const expectedSessionId = sessionIds.get(fromPeerId)
          if (expectedSessionId && msg.session_id && msg.session_id !== expectedSessionId) {
            log(`[webrtc] ignoring answer from ${fromPeerId} (stale session)`)
            break
          }
          const now = Date.now()
          const recent = recentAnswerSdp.get(fromPeerId)
          if (
            incomingAnswerSdp &&
            recent?.sdp === incomingAnswerSdp &&
            now - recent.ts < SDP_DEDUP_WINDOW_MS
          ) {
            log(`[webrtc] ignoring duplicate answer from ${fromPeerId} (dedup window)`)
            break
          }
          if (incomingAnswerSdp && conn.lastAppliedAnswerSdp === incomingAnswerSdp) {
            log(`[webrtc] ignoring duplicate answer from ${fromPeerId} (already applied)`)
            break
          }
          if (answerApplyInFlight.get(fromPeerId)) {
            pendingAnswers.set(fromPeerId, { sdp: incomingAnswerSdp, sessionId: msg.session_id ?? null, ts: Date.now() })
            log(`[webrtc] ignoring answer from ${fromPeerId} (apply in flight)`)
            break
          }
          if (conn.connection.signalingState !== 'have-local-offer') {
            pendingAnswers.set(fromPeerId, { sdp: incomingAnswerSdp, sessionId: msg.session_id ?? null, ts: Date.now() })
            log(`[webrtc] ignoring answer from ${fromPeerId} (state=${conn.connection.signalingState})`)
            break
          }
          answerApplyInFlight.set(fromPeerId, true)
          conn.connection
            .setRemoteDescription({ type: 'answer', sdp: incomingAnswerSdp })
            .then(async () => {
              log(`[webrtc] applied answer from ${fromPeerId}`)
              if (incomingAnswerSdp) {
                conn.lastAppliedAnswerSdp = incomingAnswerSdp
                recentAnswerSdp.set(fromPeerId, { sdp: incomingAnswerSdp, ts: Date.now() })
              }
              pendingAnswers.delete(fromPeerId)
              if (conn.connection.__offerRetryTimer) {
                clearInterval(conn.connection.__offerRetryTimer)
                conn.connection.__offerRetryTimer = null
              }

              const queued = pendingCandidates.get(fromPeerId) ?? []
              pendingCandidates.delete(fromPeerId)
              for (const candidate of queued) {
                await conn.connection.addIceCandidate(candidate).catch(() => {})
              }
            })
            .catch((err) => { log(`[webrtc] setRemoteDescription(answer) failed: ${err}`) })
            .finally(() => { answerApplyInFlight.delete(fromPeerId) })
        } else {
          const incomingAnswerSdp = msg.body?.sdp ?? null
          if (incomingAnswerSdp) {
            pendingAnswers.set(fromPeerId, { sdp: incomingAnswerSdp, sessionId: msg.session_id ?? null, ts: Date.now() })
            log(`[webrtc] queued answer from ${fromPeerId} (no connection yet)`)
          }
        }
        break

      case 'ice_candidate': {
        const c = msg.body?.candidate
        if (!c) break
        const expectedSessionId = sessionIds.get(fromPeerId)
        if (expectedSessionId && msg.session_id && msg.session_id !== expectedSessionId) {
          log(`[webrtc] ignoring candidate from ${fromPeerId} (stale session)`)
          break
        }
        log(`[webrtc] remote candidate from ${fromPeerId}`)
        if (conn?.connection) {
          if (conn.connection.signalingState === 'closed') break
          if (conn.connection.remoteDescription) {
            conn.connection.addIceCandidate(c).catch((err) => {
              log(`[webrtc] addIceCandidate failed: ${err}`)
            })
          } else {
            if (!pendingCandidates.has(fromPeerId)) pendingCandidates.set(fromPeerId, [])
            pendingCandidates.get(fromPeerId).push(c)
          }
        } else {
          if (!pendingCandidates.has(fromPeerId)) pendingCandidates.set(fromPeerId, [])
          pendingCandidates.get(fromPeerId).push(c)
        }
        break
      }

      case 'ice_end':
        // Remote ICE gathering complete; no further candidates will arrive.
        break

      case 'bye':
        if (conn?.connection) {
          conn.connection.close()
          mesh.connections.delete(fromPeerId)
          mesh.markDead(fromPeerId)
        }
        break

      case 'renegotiate': {
        const pc = conn?.connection
        if (!pc || pc.signalingState === 'closed') break
        ;(async () => {
          try {
            // Glare: we already sent an offer — roll it back so we can accept theirs.
            if (pc.signalingState === 'have-local-offer') {
              await pc.setLocalDescription({ type: 'rollback' })
            }
            if (pc.signalingState !== 'stable') {
              log(`[webrtc] renegotiate ignored — unexpected state: ${pc.signalingState}`)
              return
            }
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.body.sdp })
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await waitForIceGatheringComplete(pc)
            relaySignal(fromPeerId, 'answer', { sdp: pc.localDescription?.sdp ?? answer.sdp })
            if (conn) {
              conn.lastLocalAnswer = { sdp: pc.localDescription?.sdp ?? answer.sdp }
              conn.lastRemoteOfferSdp = msg.body.sdp
            }
          } catch (err) {
            log(`[webrtc] renegotiate failed: ${err}`)
          }
        })()
        break
      }
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'ack':
        if (!registered && msg.body?.status === 'ok') {
          registered = true
          setStatus('registered')
          log(`[signal] registered as ${peerId} on network ${networkId}`)
          startAdvertiseHeartbeat()
          onRegistered?.(msg)
        }
        break

      case 'peer_list': {
        const rawPeers = msg.body?.peers ?? []
        if (rawPeers.length !== lastBootstrapCountLogged) {
          lastBootstrapCountLogged = rawPeers.length
          log(`[signal] received ${rawPeers.length} peer_list candidates`)
        }
        // Bootstrap remote pub keys from peer_list hints.
        for (const p of rawPeers) {
          if (p.peer_id && p.hints?.pub && p.hints?.epub) {
            remotePubKeys.set(p.peer_id, { pub: p.hints.pub, epub: p.hints.epub })
          }
        }
        const candidates = rawPeers.map((p) => ({
          peerId:       p.peer_id,
          networkId:    p.network ?? networkId,
          capabilities: p.hints ?? {},
          advertisedAt: p.last_seen ?? Date.now(),
          advisory:     true,
          localSeenAt:  Date.now(),
        }))
        candidates.forEach((c) => mesh.addCandidate(c))
        onBootstrap?.(candidates)
        break
      }

      case 'offer':
      case 'answer':
      case 'ice_candidate':
      case 'ice_end':
      case 'bye':
      case 'renegotiate':
        handleSignalingMessage(msg).catch((err) => log(`[signal] handleSignalingMessage error: ${err}`))
        break

      case 'pong':
        // Keepalive response; intentionally silent.
        break

      case 'error':
        log(`[signal] error: ${msg.body?.code} — ${msg.body?.reason}`)
        if (msg.body?.code === 'target_not_connected') {
          log('[signal] target unavailable for relay (offline/disconnected/or other isolate)')
        }
        break

      default:
        log(`[signal] unknown message type: ${msg.type}`)
    }
  }

  function openSocket() {
    if (stoppedByUser) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    const wsUrl = new URL(signalUrl, typeof location !== 'undefined' ? location.href : undefined)
    if (!wsUrl.searchParams.get('networkId')) {
      wsUrl.searchParams.set('networkId', networkId)
    }

    setStatus('connecting')
    ws = new WebSocket(wsUrl.toString())

    ws.onopen = () => {
      if (stoppedByUser) {
        try {
          ws?.close(1000, 'stopped')
        } catch {}
        return
      }
      intentionalClose = false
      setStatus('connected')
      backoffMs = BACKOFF_BASE_MS

      ;(async () => {
        const myKeys = await _sessionKeysPromise
        send(pspEnvelope('announce', {
          ttl_ms: 30000,
          body: {
            capabilities,
            hints: { wants_peers: true, pub: myKeys.pub, epub: myKeys.epub },
            ...(auth ? { auth } : {}),
          },
        }))
        startKeepalive()
      })()
    }

    ws.onmessage = (event) => {
      if (stoppedByUser) return
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        log('[signal] received non-JSON message')
        return
      }
      handleMessage(msg)
    }

    ws.onclose = (event) => {
      registered = false
      stopAdvertiseHeartbeat()
      stopKeepalive()
      setStatus(`disconnected (${event.code})`)
      const shouldReconnect = !stoppedByUser && !(intentionalClose && event.code === 1000)
      if (shouldReconnect) {
        scheduleReconnect(openSocket, event.code)
      }
    }

    ws.onerror = () => {
      setStatus('error')
    }
  }

  function relay(toPeerId, relayType, payload) {
    if (!registered) {
      log('[signal] not registered yet')
      return
    }

    if (relayType === 'offer' || relayType === 'answer' || relayType === 'renegotiate') {
      log(`[signal] sending ${relayType} to ${toPeerId}`)
    }

    send({
      type: 'relay',
      toPeerId,
      relayType,
      payload,
      fromPeerId: peerId,
      messageId: generateMessageId(),
      timestamp: Date.now(),
    })
  }

  const unloadHandler = () => {
    client.disconnect()
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined' || document.hidden) return
    // Tab became visible (or resumed from freeze) — check if WebSocket dropped
    // while the tab was inactive.
    if (!stoppedByUser) {
      if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
        log('[signal] tab visible — WebSocket dropped while hidden, reconnecting')
        // Close and purge all stale WebRTC connections so shouldDialCandidate
        // doesn't think they are alive and block re-dialing after reconnect.
        closeAllPeerConnections()
        mesh.connections.clear()
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        backoffMs = BACKOFF_BASE_MS
        openSocket()
      } else if (registered) {
        // WS still open — close any dead WebRTC connections then refresh peers.
        for (const [rPeerId, entry] of mesh.connections.entries()) {
          if (entry.state === 'dead' || entry.state === 'failed') {
            try { entry.connection?.close() } catch {}
            mesh.connections.delete(rPeerId)
            onConnectionStateChangeCb?.({ peerId: rPeerId, state: 'closed', ts: Date.now() })
          }
        }
        client.requestBootstrap([peerId])
      }
    }
  }

  const client = {
    connect() {
      stoppedByUser = false
      intentionalClose = false
      openSocket()
    },

    requestBootstrap(excludePeerIds = [peerId]) {
      if (!registered) {
        log('[signal] not registered yet')
        return
      }
      send(pspEnvelope('discover', {
        body: { exclude_peers: excludePeerIds, limit: 10 },
      }))
    },

    relay: relaySignal,

    advertise(nextCapabilities) {
      if (!registered) return
      send(pspEnvelope('announce', {
        ttl_ms: 30000,
        body: { capabilities: nextCapabilities, hints: { wants_peers: true } },
      }))
    },

    disconnect() {
      stoppedByUser = true
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      stopAdvertiseHeartbeat()
      stopKeepalive()
      intentionalClose = true
      closeAllPeerConnections()
      mesh.connections.clear()
      mesh.bootstrapCandidates = []
      pendingCandidates.clear()
      offerProcessingQueues.clear()
      for (const remotePeerId of answerBurstTimers.keys()) {
        clearAnswerBurst(remotePeerId)
      }
      answerApplyInFlight.clear()
      sessionIds.clear()
      remotePubKeys.clear()
      registered = false

      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', unloadHandler)
      }

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        document.removeEventListener('resume', handleVisibilityChange)
      }

      if (ws) {
        send(pspEnvelope('withdraw', { body: { reason: 'user_disconnect' } }))
        ws.onmessage = null
        ws.onerror = null
        ws.close(1000, 'user_disconnect')
        ws = null
      }
    },

    async initiateConnection(toPeerId, iceServers = []) {
      return initiateWebRTCConnection(toPeerId, iceServers)
    },

    sendData(data, preferredPeerId) {
      let target = null

      if (preferredPeerId) {
        target = mesh.connections.get(preferredPeerId) ?? null
      } else {
        for (const entry of mesh.connections.values()) {
          if (entry.channel?.readyState === 'open') {
            target = entry
            break
          }
        }
      }

      if (!target?.channel || target.channel.readyState !== 'open') {
        throw new Error('WebRTC not yet connected')
      }

      target.channel.send(data)
      return target
    },

    get mesh() {
      return mesh
    },
    get peerId() {
      return peerId
    },
    get isRegistered() {
      return registered
    },
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', unloadHandler, { once: true })
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    // Page Lifecycle API: fires when a frozen tab is thawed back to active.
    // This is distinct from visibilitychange and fires first on resume.
    document.addEventListener('resume', handleVisibilityChange)
  }

  if (autoConnect) client.connect()

  return client
}

