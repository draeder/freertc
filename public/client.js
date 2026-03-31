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

// ── Peer ID ───────────────────────────────────────────────────────────────────

function generatePeerId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Persist peer ID across page loads so reconnects use the same identity.
function getOrCreatePeerId() {
  let id = sessionStorage.getItem('peerId');
  if (!id) {
    id = generatePeerId();
    sessionStorage.setItem('peerId', id);
  }
  return id;
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

// Pending ICE candidate queues — keyed by peerId.
// Candidates may arrive before the remote description is set.
const pendingCandidates = new Map();

export function connect(options = {}) {
  const {
    networkId    = NETWORK_ID,
    signalUrl    = SIGNAL_URL,
    onRegistered,
    onBootstrap,
    onIncomingRelay,
    onStatusChange,
    capabilities = {},
    auth,
  } = options;

  peerId = getOrCreatePeerId();

  function setStatus(status) {
    onStatusChange?.(status);
    log(`[signal] status: ${status}`);
  }

  function openSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setStatus('connecting');
    ws = new WebSocket(signalUrl);

    ws.onopen = () => {
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
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        log('[signal] received non-JSON message');
        return;
      }
      handleMessage(msg, { networkId, onRegistered, onBootstrap, onIncomingRelay, setStatus });
    };

    ws.onclose = (event) => {
      registered = false;
      setStatus(`disconnected (${event.code})`);
      scheduleReconnect(openSocket, event.code);
    };

    ws.onerror = () => {
      setStatus('error');
    };
  }

  openSocket();

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    /** Request bootstrap candidates from the signaling server. */
    requestBootstrap() {
      if (!registered) { log('[signal] not registered yet'); return; }
      send({ type: 'get_bootstrap', networkId });
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
      clearTimeout(reconnectTimer);
      if (ws) {
        send({ type: 'unregister' });
        ws.close(1000, 'user_disconnect');
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
}

// ── Inbound message handler ───────────────────────────────────────────────────

function handleMessage(msg, { networkId, onRegistered, onBootstrap, onIncomingRelay, setStatus }) {
  switch (msg.type) {

    case 'registered':
      registered = true;
      setStatus('registered');
      log(`[signal] registered as ${msg.peerId} on network ${msg.networkId}`);
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
      log(`[signal] relay confirmed → ${msg.toPeerId} (msgId=${msg.messageId})`);
      break;

    case 'pong':
      log(`[signal] pong latency=${Date.now() - msg.ts}ms`);
      break;

    case 'error':
      log(`[signal] error: ${msg.code} — ${msg.message}`);
      if (msg.code === 'target_not_connected') {
        // Normal — the target peer may be in a different isolate or offline.
        // Fall back to mesh routing (your Kademlia layer handles this).
        log('[signal] target not in this isolate — use mesh routing');
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

  switch (msg.relayType) {
    case 'offer':
      handleIncomingOffer(msg.fromPeerId, msg.payload, msg.networkId);
      break;

    case 'answer':
      if (conn?.connection) {
        conn.connection.setRemoteDescription(msg.payload).catch(err => {
          log(`[webrtc] setRemoteDescription(answer) failed: ${err}`);
        });
      }
      break;

    case 'candidate':
      if (conn?.connection) {
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
  const pc = createPeerConnection(toPeerId, iceServers, sendRelay);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Send offer via signaling relay.
  sendRelay('offer', offer);

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

  const pc = createPeerConnection(fromPeerId, [], sendRelay);

  await pc.setRemoteDescription(offer);

  // Drain any queued ICE candidates.
  const queued = pendingCandidates.get(fromPeerId) ?? [];
  pendingCandidates.delete(fromPeerId);
  for (const candidate of queued) {
    await pc.addIceCandidate(candidate).catch(() => {});
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendRelay('answer', answer);
}

function createPeerConnection(remotePeerId, iceServers, sendRelay) {
  const pc = new RTCPeerConnection({ iceServers });

  mesh.connections.set(remotePeerId, { connection: pc, state: 'connecting', lastSeen: Date.now() });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendRelay('candidate', event.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`[webrtc] connection to ${remotePeerId}: ${pc.connectionState}`);
    const entry = mesh.connections.get(remotePeerId);
    if (entry) entry.state = pc.connectionState;

    if (pc.connectionState === 'connected') {
      mesh.markLive(remotePeerId);
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      mesh.markDead(remotePeerId);
    }
  };

  pc.ondatachannel = (event) => {
    log(`[webrtc] data channel from ${remotePeerId}: ${event.channel.label}`);
    // Plug your mesh protocol into the data channel here.
  };

  return pc;
}

// ── Reconnect ─────────────────────────────────────────────────────────────────

function scheduleReconnect(openSocket, closeCode) {
  // Do not reconnect on clean close or explicit unregister.
  if (closeCode === 1000) return;

  log(`[signal] reconnecting in ${backoffMs}ms`);
  reconnectTimer = setTimeout(() => {
    openSocket();
  }, backoffMs);

  backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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
