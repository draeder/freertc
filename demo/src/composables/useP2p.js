/**
 * useP2p — P2P composable
 *
 * Connects via WebRTC/WebSocket signaling:
 *
 *  • raw  – WebRTC P2P via relay signaling
 *
 * Exposes a reactive interface so the parent component (App.vue) can
 * drive a peer instance without any protocol-specific code.
 */
import { ref, toValue, watch, onUnmounted } from 'vue'
import { createSignalingClient } from '../utils/signalingClient.js'

export function useP2p({
  tech,          // ref<'raw'>
  serverUrl,     // ref<string>
  topicHash,     // ref<string>   – SHA-256 hex of the room topic
  peerId,        // ref<string>   – this peer's unique ID
  sharedMagnet,  // ref<string>   – unused, kept for API compat
  onShare,       // fn(key, value) – called when this peer has data to share
}) {
  // ── public reactive state ────────────────────────────────────────────────
  const status     = ref('disconnected') // disconnected | connecting | connected | error
  const logs       = ref([])
  const messages   = ref([])  // { id, from: 'me'|'them', text, ts }
  const peerCount  = ref(0)

  // ── internal handles ─────────────────────────────────────────────────────
  let _ws         = null   // WebSocket
  let _rtcPeer    = null   // RTCPeerConnection
  let _rtcChannel = null   // RTCDataChannel for WebRTC signaling
  let _sendFn     = null   // send implementation
  let _peerCleanup = null  // peer-specific timer cleanup
  let _signalingClient = null

  // ── helpers ──────────────────────────────────────────────────────────────
  function _ts() {
    return new Date().toLocaleTimeString(undefined, { hour12: false })
  }

  function addLog(type, text) {
    logs.value.push({ id: Date.now() + Math.random(), type, text, ts: _ts() })
  }

  function addMessage(from, text) {
    messages.value.push({ id: Date.now() + Math.random(), from, text, ts: _ts() })
  }

  function _closeWs() {
    if (_ws) { try { _ws.close() } catch { /* ignore */ } _ws = null }
  }

  function _closePeer() {
    if (_rtcChannel) {
      try { _rtcChannel.close() } catch { /* ignore */ }
      _rtcChannel = null
    }
    if (_rtcPeer) {
      try {
        if (typeof _rtcPeer.destroy === 'function') _rtcPeer.destroy()
        else if (typeof _rtcPeer.close === 'function') _rtcPeer.close()
      } catch {
        /* ignore */
      }
      _rtcPeer = null
    }
  }

  function _resetAll() {
    if (_peerCleanup) {
      try { _peerCleanup() } catch { /* ignore */ }
      _peerCleanup = null
    }
    _closePeer()
    _closeWs()
    _sendFn       = null
    status.value    = 'disconnected'
    peerCount.value = 0
    messages.value  = []
  }

  function _connectPeerOoo(modeLabel) {
    const rawUrl = String(toValue(serverUrl) || '').trim()
    const networkId = String(toValue(topicHash) || '').trim()
    const localPeerId = String(toValue(peerId) || '').trim()

    if (!window.RTCPeerConnection) {
      status.value = 'error'
      addLog('error', 'WebRTC not supported in this browser.')
      return
    }

    status.value = 'connecting'
    addLog('info', `Connecting to ${rawUrl}`)

    let isRegistered = false
    const activeDialPeerIds = new Set()
    const lastDialAttemptAt = new Map()
    let lastLoggedCandidateCount = -1
    const RETRY_SAME_PEER_AFTER_MS = 60000  // 1 min before redialing a non-responsive peer
    const MAX_PARALLEL_DIALS = 3
    const BOOTSTRAP_REFRESH_MS = 5000
    let bootstrapRefreshTimer = null

    const defaultIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]

    _peerCleanup = () => {
      clearInterval(bootstrapRefreshTimer)
      bootstrapRefreshTimer = null
      if (_signalingClient) {
        _signalingClient.disconnect()
        _signalingClient = null
      }
      _rtcPeer = null
      _rtcChannel = null
    }

    function startBootstrapRefresh() {
      clearInterval(bootstrapRefreshTimer)
      bootstrapRefreshTimer = setInterval(() => {
        if (!isRegistered) return
        _signalingClient?.requestBootstrap([localPeerId])
      }, BOOTSTRAP_REFRESH_MS)
    }

    function isMeshAliveState(state) {
      return state === 'connected' || state === 'connecting' || state === 'recovering'
    }

    function connectedPeerCount() {
      let count = 0
      for (const entry of _signalingClient?.mesh.connections.values() ?? []) {
        if (entry?.state === 'connected' || entry?.channel?.readyState === 'open') count++
      }
      return count
    }

    function updateStatusFromMesh() {
      const count = connectedPeerCount()
      peerCount.value = count
      if (status.value === 'error') return
      if (count > 0) {
        status.value = 'connected'
      } else if (isRegistered) {
        status.value = 'connecting'
      } else {
        status.value = 'disconnected'
      }
    }

    function shouldDialCandidate(candidate) {
      const remotePeerId = candidate?.peerId
      if (!remotePeerId || remotePeerId === localPeerId) return false

      // Auto-negotiate: the peer with the lexicographically smaller ID sends the offer.
      if (localPeerId >= remotePeerId) return false
      if (activeDialPeerIds.has(remotePeerId)) return false

      const existing = _signalingClient?.mesh.connections.get(remotePeerId)

      // Allow redialing dead peers after the retry window — they may have reconnected.
      if (existing?.state === 'dead') {
        const lastTriedAt = lastDialAttemptAt.get(remotePeerId) ?? 0
        return Date.now() - lastTriedAt >= RETRY_SAME_PEER_AFTER_MS
      }

      if (existing && isMeshAliveState(existing.state) && existing.connection?.signalingState !== 'closed') {
        return false
      }

      const lastTriedAt = lastDialAttemptAt.get(remotePeerId) ?? 0
      if (Date.now() - lastTriedAt < RETRY_SAME_PEER_AFTER_MS) return false

      return true
    }

    function sortCandidates(candidates) {
      return (candidates || [])
        .filter((candidate) => candidate?.peerId && candidate.peerId !== localPeerId)
        .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
    }

    function maybeDialCandidates(candidates) {
      const sorted = sortCandidates(candidates)
      for (const candidate of sorted) {
        if (activeDialPeerIds.size >= MAX_PARALLEL_DIALS) break
        if (!shouldDialCandidate(candidate)) continue

        const remotePeerId = candidate.peerId
        activeDialPeerIds.add(remotePeerId)
        lastDialAttemptAt.set(remotePeerId, Date.now())
        addLog('info', `Initiating WebRTC with ${remotePeerId.slice(0, 12)}…`)

        _signalingClient
          ?.initiateConnection(remotePeerId, defaultIceServers)
          .then((pc) => {
            _rtcPeer = pc ?? _rtcPeer
          })
          .catch((err) => {
            addLog('error', `Offer failed (${remotePeerId.slice(0, 12)}): ${err.message}`)
          })
          .finally(() => {
            activeDialPeerIds.delete(remotePeerId)
          })
      }
    }

    function normalizeStatus(rawStatus) {
      if (rawStatus === 'registered' || rawStatus === 'connected') return 'connecting'
      if (rawStatus === 'connecting') return 'connecting'
      if (rawStatus === 'error') return 'error'
      if (rawStatus.startsWith('disconnected')) return 'disconnected'
      return status.value
    }

    _signalingClient = createSignalingClient({
      peerId: localPeerId,
      networkId,
      signalUrl: rawUrl,
      capabilities: { role: 'browser', mode: modeLabel.toLowerCase() },
      onLog: (message) => {
        const type = message.includes('error') ? 'error' : message.includes('incoming') ? 'recv' : 'info'
        addLog(type, message)
      },
      onStatusChange: (nextStatus) => {
        const normalized = normalizeStatus(nextStatus)
        status.value = normalized
        if (nextStatus.startsWith('disconnected') || nextStatus === 'error') {
          isRegistered = false
        }
        if (nextStatus === 'error') {
          addLog('error', 'Signaling server error - check the URL.')
        }
      },
      onRegistered: (message) => {
        addLog('success', `Registered in network ${message.network ?? networkId}`)
        isRegistered = true
        activeDialPeerIds.clear()
        lastDialAttemptAt.clear()
        updateStatusFromMesh()
        startBootstrapRefresh()
        // Server pushes same-isolate peers immediately after registered.
        // Also request bootstrap for cross-isolate (MongoDB) peers.
        // Retry a handful of times with backoff in case of write-lag.
        let retries = 0
        const RETRY_DELAYS_MS = [0, 500, 1500, 3500]
        function tryBootstrap() {
          _signalingClient?.requestBootstrap([localPeerId])
          retries++
          if (retries < RETRY_DELAYS_MS.length) {
            setTimeout(tryBootstrap, RETRY_DELAYS_MS[retries])
          }
        }
        tryBootstrap()
      },
      onBootstrap: async (candidates) => {
        const remoteCandidates = (candidates || []).filter((candidate) => candidate.peerId && candidate.peerId !== localPeerId)
        if (remoteCandidates.length === 0) return
        // Only log if new candidates have arrived (count increased)
        if (remoteCandidates.length > lastLoggedCandidateCount) {
          addLog('success', `Got ${remoteCandidates.length} candidate(s)`)
          lastLoggedCandidateCount = remoteCandidates.length
        }
        maybeDialCandidates(remoteCandidates)
      },
      onIncomingRelay: (message) => {
        addLog('recv', `[signal] incoming ${message.type} from ${String(message.from ?? '').slice(0, 12)}`)
      },
      onConnectionStateChange: ({ peerId: remotePeerId, state }) => {
        _rtcPeer = _signalingClient?.mesh.connections.get(remotePeerId)?.connection ?? _rtcPeer
        _rtcChannel = _signalingClient?.mesh.connections.get(remotePeerId)?.channel ?? _rtcChannel
        addLog(state === 'failed' ? 'error' : 'info', `WebRTC state: ${state}`)
        if (['failed', 'closed', 'dead', 'disconnected'].includes(state)) {
          activeDialPeerIds.delete(remotePeerId)
          // Allow immediate re-dial so the non-suspended peer doesn't wait up to
          // RETRY_SAME_PEER_AFTER_MS (60 s) before redialing a peer that just left
          // and came back (e.g. after a tab suspend/resume cycle).
          if (['failed', 'closed', 'dead'].includes(state)) {
            lastDialAttemptAt.delete(remotePeerId)
          }
          if (isRegistered) {
            _signalingClient?.requestBootstrap([localPeerId])
          }
        }
        updateStatusFromMesh()
      },
      onDataMessage: ({ peerId: fromPeerId, data }) => {
        let parsed = null
        try { parsed = JSON.parse(data) } catch { /* not JSON */ }
        if (parsed?.type === 'chat' && typeof parsed.text === 'string') {
          addMessage('them', parsed.text)
        } else {
          addLog('recv', `[P2P] ${typeof data === 'string' ? data : '[binary]'}`)
        }
      },
    })

    _ws = null

    _sendFn = (text) => {
      try {
        const envelope = JSON.stringify({ type: 'chat', text })
        let sentCount = 0
        for (const [remotePeerId, entry] of _signalingClient?.mesh.connections.entries() ?? []) {
          if (entry?.channel?.readyState === 'open') {
            try {
              _signalingClient?.sendData(envelope, remotePeerId)
              sentCount += 1
            } catch {
              // Ignore transient per-peer send failures.
            }
          }
        }
        if (sentCount === 0) {
          throw new Error('WebRTC not yet connected')
        }
        for (const entry of _signalingClient?.mesh.connections.values() ?? []) {
          if (entry?.channel?.readyState === 'open') {
            _rtcChannel = entry.channel
            break
          }
        }
        addMessage('me', text)
        if (sentCount > 1) {
          addLog('send', `Broadcast to ${sentCount} peers`)
        }
      } catch (err) {
        addLog('warn', err.message)
      }
    }
  }

  // ── public API ────────────────────────────────────────────────────────────
  async function connect() {
    _resetAll()
    logs.value = []

    const url = String(toValue(serverUrl) || '').trim()
    const room = String(toValue(topicHash) || '').trim()
    if (!url || !room) {
      status.value = 'error'
      addLog('warn', 'Enter both server URL and room/topic before connecting.')
      return
    }

    try {
      _connectPeerOoo('raw')
    } catch (err) {
      status.value = 'error'
      addLog('error', `Unexpected error: ${err.message}`)
    }
  }

  function disconnect() {
    _resetAll()
  }

  function send(text) {
    if (_sendFn) {
      const r = _sendFn(text)
      if (r && typeof r.then === 'function') {
        r.catch((err) => addLog('error', err.message))
      }
    } else {
      addLog('warn', 'Send not available for this technology / state.')
    }
  }

  function clearLogs() {
    logs.value = []
  }

  function clearMessages() {
    messages.value = []
  }

  onUnmounted(disconnect)

  return { status, logs, messages, peerCount, connect, disconnect, send, clearLogs, clearMessages }
}
