// public/client.js — Browser WebRTC signaling client for peer.ooo
//
// This client demonstrates the full signaling flow:
//   1. Connect to wss://peer.ooo/ws
//   2. Register with a peerId and networkId
//   3. Request bootstrap candidates
//   4. Exchange WebRTC offer/answer/candidate via relay
//   5. Reconnect with exponential backoff
//
// DESIGN NOTES:
//   - The Worker is ONLY a rendezvous/signaling edge.
//   - The mesh (Kademlia buckets, partial mesh, liveness state) lives HERE,
//     in the client. The Worker has no knowledge of mesh topology.
//   - Bootstrap candidates may be stale. The client must verify liveness.
//   - Relay only works if both peers happen to land on the same Worker isolate.
//     For production, implement direct peer-to-peer fallback via your mesh.

// ── Configuration ─────────────────────────────────────────────────────────────

const SIGNAL_URL   = 'wss://peer.ooo/ws';  // Change for local dev: ws://localhost:8787/ws
const NETWORK_ID   = 'default';            // Override per deployment

// Backoff config for reconnect
const BACKOFF_BASE_MS  = 1_000;
const BACKOFF_MAX_MS   = 30_000;
const BACKOFF_FACTOR   = 1.5;
const DATA_PING_MS     = 3_000;
const DATA_PONG_TIMEOUT_MS = 12_000;

// ── Peer ID ───────────────────────────────────────────────────────────────────

function generatePeerId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Generate a fresh peer ID for each page session.
function createSessionPeerId() {
  return generatePeerId();
}

// ── Local mesh state (client-owned, not Worker-owned) ─────────────────────────
// The Worker never knows about this structure.

const mesh = {
  // Kademlia-like routing table placeholder.
  // In a real implementation, this would be a proper k-bucket structure.
  buckets: {},

  // Peers we have an active or pending WebRTC connection with.
  // Map<peerId, { connection: RTCPeerConnection, state: string, lastSeen: number }>
  connections: new Map(),

  // Advisory candidates from the last bootstrap response.
  // These may be stale. We track freshness ourselves.
  bootstrapCandidates: [],

  // Add a candidate to local knowledge. Deduplicates by peerId.
  addCandidate(candidate) {
    const existing = mesh.bootstrapCandidates.findIndex(c => c.peerId === candidate.peerId);
    if (existing >= 0) {
      mesh.bootstrapCandidates[existing] = { ...candidate, localSeenAt: Date.now() };
    } else {
      mesh.bootstrapCandidates.push({ ...candidate, localSeenAt: Date.now() });
    }
  },

  // Return candidates that are not stale by our local freshness threshold.
  getFreshCandidates(maxAgeMs = 10 * 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    return mesh.bootstrapCandidates.filter(c => c.localSeenAt > cutoff);
  },

  // Update liveness state for a peer.
  markLive(peerId) {
    const conn = mesh.connections.get(peerId);
    if (conn) conn.lastSeen = Date.now();
  },

  markDead(peerId) {
    const conn = mesh.connections.get(peerId);
    if (conn) {
      conn.state = 'dead';
    }
  },
};

// ── Signaling client ──────────────────────────────────────────────────────────

let ws         = null;
let peerId     = null;
let registered = false;
let backoffMs  = BACKOFF_BASE_MS;
let reconnectTimer = null;
let mailboxPollTimer = null;
let advertiseHeartbeatTimer = null;
let keepaliveTimer = null;  // Heartbeat to keep peer alive in KV
let intentionalClose = false;
let stoppedByUser = false;
let recentPeerIds = [];  // Track recent session peer IDs to avoid self-reconnect
let onConnectionStateChangeCb = null;

// Pending ICE candidate queues — keyed by peerId.
// Candidates may arrive before the remote description is set.
const pendingCandidates = new Map();

// Load recent peer IDs from localStorage to filter old self IDs from bootstrap.
function loadRecentPeerIds() {
  try {
    const raw = localStorage?.getItem('freertc:recentPeerIds');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];  // localStorage may not be available in some contexts
  }
}

// Save current peer ID to localStorage for next sessions.
function saveCurrentPeerId(id) {
  try {
    const next = [id, ...recentPeerIds.filter((x) => x !== id)].slice(0, 16);
    recentPeerIds = next;
    localStorage?.setItem('freertc:recentPeerIds', JSON.stringify(next));
  } catch {
    // localStorage may not be available in some contexts
  }
}

export function connect(options = {}) {
  const {
    networkId    = NETWORK_ID,
    signalUrl    = SIGNAL_URL,
    onRegistered,
    onBootstrap,
    onIncomingRelay,
    onConnectionStateChange,
    onStatusChange,
    capabilities = {},
    auth,
  } = options;

  onConnectionStateChangeCb = typeof onConnectionStateChange === 'function' ? onConnectionStateChange : null;
  stoppedByUser = false;
  intentionalClose = false;

  recentPeerIds = loadRecentPeerIds();
  peerId = createSessionPeerId();
  saveCurrentPeerId(peerId);

  function setStatus(status) {
    onStatusChange?.(status);
    log(`[signal] status: ${status}`);
  }

  function openSocket() {
    if (stoppedByUser) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Attach networkId in the URL for network-scoped signaling.
    const wsUrl = new URL(signalUrl, typeof location !== 'undefined' ? location.href : undefined);
    if (!wsUrl.searchParams.get('networkId')) {
      wsUrl.searchParams.set('networkId', networkId);
    }

    setStatus('connecting');
    ws = new WebSocket(wsUrl.toString());

    ws.onopen = () => {
      if (stoppedByUser) {
        try { ws?.close(1000, 'stopped'); } catch {}
        return;
      }
      intentionalClose = false;
      setStatus('connected');
      backoffMs = BACKOFF_BASE_MS;

      // Send registration immediately on connect.
      send({
        type:         'register',
        peerId,
        networkId,
        timestamp:    Date.now(),
        capabilities,
        ...(auth ? { auth } : {}),
      });
      startKeepalive();  // Start sending pings to keep peer alive in KV
    };

    ws.onmessage = (event) => {
      if (stoppedByUser) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        log('[signal] received non-JSON message');
        return;
      }
      handleMessage(msg, {
        networkId,
        onRegistered,
        onBootstrap,
        onIncomingRelay,
        setStatus,
        capabilities,
      });
    };

    ws.onclose = (event) => {
      registered = false;
      stopMailboxPolling();
      stopAdvertiseHeartbeat();
      stopKeepalive();
      setStatus(`disconnected (${event.code})`);
      const shouldReconnect = !stoppedByUser && !(intentionalClose && event.code === 1000);
      if (shouldReconnect) {
        scheduleReconnect(openSocket, event.code);
      }
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }

  openSocket();

  // ── Public API ──────────────────────────────────────────────────────────────
  const client = {
    /** Request bootstrap candidates from the signaling server. */
    requestBootstrap() {
      if (!registered) { log('[signal] not registered yet'); return; }
      const excludePeerIds = recentPeerIds.filter((id) => id && id !== peerId);
      send({ type: 'get_bootstrap', networkId, excludePeerIds });
    },

    /** Send a WebRTC relay message to a target peer. */
    relay(toPeerId, relayType, payload) {
      if (!registered) { log('[signal] not registered yet'); return; }
      send({
        type:      'relay',
        toPeerId,
        relayType,
        payload,
        fromPeerId: peerId,
        messageId:  generateMessageId(),
        timestamp:  Date.now(),
      });
    },

    /** Advertise updated capabilities. */
    advertise(caps) {
      if (!registered) return;
      send({ type: 'advertise', capabilities: caps });
    },

    /** Gracefully unregister and close. */
    disconnect() {
      stoppedByUser = true;
      clearTimeout(reconnectTimer);
      stopMailboxPolling();
      stopAdvertiseHeartbeat();
      stopKeepalive();
      intentionalClose = true;
      closeAllPeerConnections();
      mesh.connections.clear();
      mesh.bootstrapCandidates = [];
      pendingCandidates.clear();
      registered = false;
      if (ws) {
        send({ type: 'unregister' });
        ws.onmessage = null;
        ws.onerror = null;
        ws.close(1000, 'user_disconnect');
        ws = null;
      }
    },

    /** Send a WebRTC offer to a target peer. Manages RTCPeerConnection lifecycle. */
    async initiateConnection(toPeerId, iceServers = []) {
      return initiateWebRTCConnection(toPeerId, iceServers, (relayType, payload) => {
        send({
          type:      'relay',
          toPeerId,
          relayType,
          payload,
          fromPeerId: peerId,
          messageId:  generateMessageId(),
          timestamp:  Date.now(),
        });
      });
    },

    /** Expose local mesh state for inspection. */
    get mesh() { return mesh; },
    get peerId() { return peerId; },
    get isRegistered() { return registered; },
  };

  // Immediately unregister on page unload so KV doesn't hold stale peer data.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      client.disconnect();
    }, { once: true });
  }

  return client;
}

// ── Inbound message handler ───────────────────────────────────────────────────

function handleMessage(msg, {
  networkId,
  onRegistered,
  onBootstrap,
  onIncomingRelay,
  setStatus,
  capabilities,
}) {
  switch (msg.type) {

    case 'registered':
      registered = true;
      setStatus('registered');
      log(`[signal] registered as ${msg.peerId} on network ${msg.networkId}`);
      startMailboxPolling(networkId);
      startAdvertiseHeartbeat(capabilities);
      onRegistered?.(msg);
      break;

    case 'bootstrap_candidates':
      log(`[signal] received ${msg.candidates?.length ?? 0} bootstrap candidates`);
      (msg.candidates ?? []).forEach(c => mesh.addCandidate(c));
      onBootstrap?.(msg.candidates ?? []);
      break;

    case 'incoming_relay':
      handleIncomingRelay(msg, onIncomingRelay);
      break;

    case 'relayed':
      log(`[signal] relay confirmed → ${msg.toPeerId} (msgId=${msg.messageId}${msg.via ? ` via=${msg.via}` : ''})`);
      break;

    case 'pong':
      // Keepalive response; intentionally silent to avoid log spam.
      break;

    case 'advertised':
      // Heartbeat ack; keep logs quiet.
      break;

    case 'error':
      log(`[signal] error: ${msg.code} — ${msg.message}`);
      if (msg.code === 'target_not_connected') {
        // The target may be offline, disconnected, or in a different isolate.
        log('[signal] target unavailable for relay (offline/disconnected/or other isolate)');
      }
      break;

    default:
      log(`[signal] unknown message type: ${msg.type}`);
  }
}

// ── WebRTC relay dispatch ─────────────────────────────────────────────────────

function handleIncomingRelay(msg, onIncomingRelay) {
  log(`[signal] incoming ${msg.relayType} from ${msg.fromPeerId}`);

  // Always notify the application layer.
  onIncomingRelay?.(msg);

  // Plug WebRTC signaling messages into the appropriate RTCPeerConnection.
  const conn = mesh.connections.get(msg.fromPeerId);
  if (!conn && (msg.relayType === 'offer' || msg.relayType === 'answer' || msg.relayType === 'candidate' || msg.relayType === 'renegotiate')) {
    onConnectionStateChangeCb?.({ peerId: msg.fromPeerId, state: 'connecting', ts: Date.now() });
  }
  if (conn) {
    conn.lastSeen = Date.now();
    if (conn.state !== 'connected') conn.state = 'connecting';
  }

  switch (msg.relayType) {
    case 'offer':
      handleIncomingOffer(msg.fromPeerId, msg.payload, msg.networkId).catch((err) => {
        log(`[webrtc] handleIncomingOffer failed: ${err}`);
      });
      break;

    case 'answer':
      if (conn?.connection) {
        if (conn.connection.signalingState !== 'have-local-offer') break;
        conn.connection.setRemoteDescription(msg.payload).then(() => {
          if (conn.connection.__offerRetryTimer) {
            clearInterval(conn.connection.__offerRetryTimer);
            conn.connection.__offerRetryTimer = null;
          }
        }).catch(err => {
          log(`[webrtc] setRemoteDescription(answer) failed: ${err}`);
        });
      }
      break;

    case 'candidate':
      if (conn?.connection) {
        if (conn.connection.signalingState === 'closed') break;
        if (conn.connection.remoteDescription) {
          conn.connection.addIceCandidate(msg.payload).catch(err => {
            log(`[webrtc] addIceCandidate failed: ${err}`);
          });
        } else {
          // Queue until remote description is set.
          if (!pendingCandidates.has(msg.fromPeerId)) {
            pendingCandidates.set(msg.fromPeerId, []);
          }
          pendingCandidates.get(msg.fromPeerId).push(msg.payload);
        }
      }
      break;

    case 'bye':
      if (conn?.connection) {
        conn.connection.close();
        mesh.connections.delete(msg.fromPeerId);
        mesh.markDead(msg.fromPeerId);
      }
      break;

    case 'renegotiate':
      if (conn?.connection) {
        conn.connection.setRemoteDescription(msg.payload).then(() => {
          return conn.connection.createAnswer();
        }).then(answer => {
          return conn.connection.setLocalDescription(answer).then(() => answer);
        }).then(answer => {
          send({
            type:       'relay',
            toPeerId:   msg.fromPeerId,
            relayType:  'answer',
            payload:    answer,
            fromPeerId: peerId,
            messageId:  generateMessageId(),
            timestamp:  Date.now(),
          });
        }).catch(err => {
          log(`[webrtc] renegotiate failed: ${err}`);
        });
      }
      break;
  }
}

// ── WebRTC helpers ────────────────────────────────────────────────────────────

async function initiateWebRTCConnection(toPeerId, iceServers, sendRelay) {
  const pc = createPeerConnection(toPeerId, iceServers, sendRelay, onConnectionStateChangeCb);

  // Ensure the offer includes a data channel m-line.
  const dc = pc.createDataChannel('mesh');
  attachDataChannelHandlers(dc, toPeerId, pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Send offer via signaling relay.
  sendRelay('offer', offer);

  // KV mailbox can lag; retry the same offer until answer arrives.
  let retries = 0;
  const retryTimer = setInterval(() => {
    if (pc.signalingState === 'closed' || pc.remoteDescription) {
      clearInterval(retryTimer);
      return;
    }
    if (pc.signalingState !== 'have-local-offer') {
      clearInterval(retryTimer);
      return;
    }
    if (retries >= 8) {
      clearInterval(retryTimer);
      return;
    }
    retries += 1;
    sendRelay('offer', offer);
  }, 1200);
  pc.__offerRetryTimer = retryTimer;

  return pc;
}

async function handleIncomingOffer(fromPeerId, offer, networkId) {
  // Create a peer connection for the answering side.
  const sendRelay = (relayType, payload) => {
    send({
      type:       'relay',
      toPeerId:   fromPeerId,
      relayType,
      payload,
      fromPeerId: peerId,
      messageId:  generateMessageId(),
      timestamp:  Date.now(),
    });
  };

  const existing = mesh.connections.get(fromPeerId)?.connection;
  const pc = (existing && existing.signalingState !== 'closed')
    ? existing
    : createPeerConnection(fromPeerId, [], sendRelay, onConnectionStateChangeCb);

  if (pc.signalingState === 'closed') return;
  await pc.setRemoteDescription(offer);

  // Drain any queued ICE candidates.
  const queued = pendingCandidates.get(fromPeerId) ?? [];
  pendingCandidates.delete(fromPeerId);
  for (const candidate of queued) {
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  const answer = await pc.createAnswer();
  if (pc.signalingState === 'closed') return;
  await pc.setLocalDescription(answer);
  sendRelay('answer', answer);
}

function createPeerConnection(remotePeerId, iceServers, sendRelay, onConnectionStateChange) {
  const pc = new RTCPeerConnection({ iceServers });
  let restartTimer = null;
  let restartInFlight = false;

  mesh.connections.set(remotePeerId, { connection: pc, state: 'connecting', lastSeen: Date.now() });
  onConnectionStateChange?.({ peerId: remotePeerId, state: 'connecting', ts: Date.now() });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendRelay('candidate', event.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`[webrtc] connection to ${remotePeerId}: ${pc.connectionState}`);
    const entry = mesh.connections.get(remotePeerId);
    if (entry) {
      entry.state = pc.connectionState;
      entry.lastSeen = Date.now();
    }
    onConnectionStateChange?.({ peerId: remotePeerId, state: pc.connectionState, ts: Date.now() });

    if (pc.connectionState === 'connected') {
      mesh.markLive(remotePeerId);
      restartInFlight = false;
      clearTimeout(restartTimer);
      restartTimer = null;
    } else if (pc.connectionState === 'disconnected') {
      // Transient in many networks; let ICE restart attempt recovery first.
      const entry = mesh.connections.get(remotePeerId);
      if (entry) entry.state = 'recovering';
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      mesh.markDead(remotePeerId);
    }

    if (pc.connectionState === 'closed') {
      clearTimeout(restartTimer);
      restartTimer = null;
      if (pc.__offerRetryTimer) {
        clearInterval(pc.__offerRetryTimer);
        pc.__offerRetryTimer = null;
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`[webrtc] ice to ${remotePeerId}: ${pc.iceConnectionState}`);

    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      restartInFlight = false;
      clearTimeout(restartTimer);
      restartTimer = null;
      return;
    }

    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      if (restartInFlight || restartTimer) return;

      // Prevent renegotiation glare loops: only one side initiates ICE restarts.
      // The peer with lexicographically smaller peerId acts as restart owner.
      const isRestartOwner = typeof peerId === 'string' && peerId < remotePeerId;
      if (!isRestartOwner) return;

      // Give transient network blips a short grace period, then try ICE restart.
      restartTimer = setTimeout(async () => {
        restartTimer = null;
        if (pc.signalingState === 'closed') return;
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;

        restartInFlight = true;
        try {
          log(`[webrtc] ice restart to ${remotePeerId}`);
          const restartOffer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(restartOffer);
          sendRelay('renegotiate', restartOffer);
        } catch (err) {
          restartInFlight = false;
          log(`[webrtc] ice restart failed for ${remotePeerId}: ${err}`);
        }
      }, 3000);
    }
  };

  pc.ondatachannel = (event) => {
    attachDataChannelHandlers(event.channel, remotePeerId, pc);
  };

  return pc;
}

function attachDataChannelHandlers(channel, remotePeerId, pc) {
  let keepaliveTimer = null;
  let lastPongAt = Date.now();

  channel.onopen = () => {
    log(`[webrtc] data channel open to ${remotePeerId}`);
    lastPongAt = Date.now();

    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (channel.readyState !== 'open') return;

      if (Date.now() - lastPongAt > DATA_PONG_TIMEOUT_MS) {
        log(`[webrtc] data channel timeout to ${remotePeerId}; closing peer connection`);
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        try { channel.close(); } catch {}
        try { pc.close(); } catch {}
        mesh.markDead(remotePeerId);
        return;
      }

      try {
        channel.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        // Ignore transient send errors.
      }
    }, DATA_PING_MS);
  };

  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      log(`[P2P direct] ${event.data}`);
      return;
    }

    if (msg?.type === 'ping') {
      try {
        channel.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } catch {
        // Ignore send failure.
      }
      return;
    }

    if (msg?.type === 'pong') {
      lastPongAt = Date.now();
      return;
    }

    log(`[P2P direct] ${event.data}`);
  };

  channel.onclose = () => {
    log(`[webrtc] data channel closed to ${remotePeerId}`);
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };

  channel.onerror = (err) => {
    log(`[webrtc] data channel error to ${remotePeerId}: ${err}`);
  };
}

// ── Reconnect ─────────────────────────────────────────────────────────────────

function scheduleReconnect(openSocket, closeCode) {
  // Do not reconnect on clean close or explicit unregister.
  if (closeCode === 1000 || stoppedByUser) return;

  log(`[signal] reconnecting in ${backoffMs}ms`);
  reconnectTimer = setTimeout(() => {
    openSocket();
  }, backoffMs);

  backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
}

function closeAllPeerConnections() {
  for (const [peerId, entry] of mesh.connections.entries()) {
    try { entry.connection?.close(); } catch {}
    onConnectionStateChangeCb?.({ peerId, state: 'closed', ts: Date.now() });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function startMailboxPolling(networkId) {
  stopMailboxPolling();
  mailboxPollTimer = setInterval(() => {
    if (!registered) return;
    send({ type: 'pull_mailbox', networkId });
  }, 500);
}

function stopMailboxPolling() {
  clearInterval(mailboxPollTimer);
  mailboxPollTimer = null;
}

function startAdvertiseHeartbeat(capabilities) {
  stopAdvertiseHeartbeat();
  advertiseHeartbeatTimer = setInterval(() => {
    if (!registered) return;
    send({ type: 'advertise', capabilities });
  }, 5000);
}

function stopAdvertiseHeartbeat() {
  clearInterval(advertiseHeartbeatTimer);
  advertiseHeartbeatTimer = null;
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (!registered) return;
    send({ type: 'ping', ts: Date.now() });
  }, 3000);  // 3 seconds — keeps KV timestamp comfortably within active cutoff
}

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function generateMessageId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function log(msg) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${ts} ${msg}`);
  const el = document.getElementById('log');
  if (el) {
    const line = document.createElement('div');
    line.textContent = `${ts} ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
}
