import { createApp, computed, nextTick, onMounted, ref, watch } from "https://unpkg.com/vue@3.5.13/dist/vue.esm-browser.prod.js";

const PSP_VERSION = "1.0";
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SHARED_IDS_KEY = "freertc.shared.ids.v1";

function newId(prefix = "msg") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function now() {
  return Date.now();
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function isValidPeerId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const peerId = value.trim();
  if (!peerId || peerId.length > 256) {
    return false;
  }

  // Strict profile: token-safe IDs only (no whitespace) and fingerprint-like length.
  if (!/^[A-Za-z0-9._:/-]+$/.test(peerId)) {
    return false;
  }

  // Accept common fingerprint styles and app IDs that are long enough to avoid weak collisions.
  const isHexFingerprint = /^[a-f0-9]{40,128}$/i.test(peerId);
  const isMultibaseLike = /^[zbu][A-Za-z0-9]{16,}$/i.test(peerId);
  const isOpaqueStrongToken = peerId.length >= 16;
  return isHexFingerprint || isMultibaseLike || isOpaqueStrongToken;
}

function isSpecToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value);
}

createApp({
  setup() {
    const host = window.location.host;
    const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";

    const wsUrl = ref(`${wsScheme}://${host}/ws`);
    const status = ref("disconnected");
    const socket = ref(null);

    const network = ref("room:test");

    function normalizedWsUrlValue() {
      const trimmed = (wsUrl.value || "").trim();
      return trimmed || `${wsScheme}://${host}/ws`;
    }

    function normalizedNetworkValue() {
      const trimmed = (network.value || "").trim();
      return trimmed || "room:test";
    }

    // Keep peer identity in-memory per tab so duplicate tabs cannot share IDs.
    function getOrAssignPeerId() {
      return randomHex();
    }

    const fromPeer = ref(getOrAssignPeerId());
    const appliedWsUrl = ref(wsUrl.value);
    const appliedNetwork = ref(network.value);
    const appliedFromPeer = ref(fromPeer.value);
    const toPeer = ref("");
    const sessionId = ref("");
    const instanceId = ref("");

    const activeView = ref("webrtc");
    const relayType = ref("announce");
    const relayBody = ref('{\n  "roles": ["peer"]\n}');

    const rtcPhase = ref("idle");
    const rtcState = ref("new");
    const dataState = ref("closed");
    const chatInput = ref("");
    const chatSendMode = ref("broadcast");
    const chatLog = ref([]);
    const chatThreadRef = ref(null);
    const debugExpanded = ref(false);

    const discoveredPeers = ref([]);
    const autoDiscovery = ref(true);
    const autoConnect = ref(true);
    const meshConnectedCount = ref(0);
    const meshTargetCount = ref(0);

    let discoveryTimer = null;
    let reconnectTimer = null;
    let lastDiscoverSyncAt = 0;
    let manualDisconnect = false;
    let stoppingRtc = false;
    let reconnectLockedByBye = false;
    const CONNECT_REQUEST_TIMEOUT_MS = 10000; // 10 second timeout
    const DISCOVER_SYNC_INTERVAL_MS = 10000;
    const FAILED_PEER_COOLDOWN_MS = 5000;
    const BYE_COOLDOWN_MS = 30000;
    const LIVE_PEER_MAX_AGE_MS = 25000;
    const failedPeerCooldowns = new Map();
    const byeCooldowns = new Map();
    const meshLinks = new Map();

    const logs = ref([]);

    const isConnected = computed(() => status.value === "connected");
    const canConnect = computed(() => {
      const ws = socket.value;
      if (!ws) {
        return status.value !== "connecting";
      }
      return ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED;
    });
    const canDisconnect = computed(() => {
      const ws = socket.value;
      if (!ws) {
        return status.value === "connecting" || status.value === "connected";
      }
      return ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN;
    });
    const canRunRtc = computed(() => isConnected.value && (Boolean(toPeer.value) || autoDiscovery.value));
    const chatMessages = computed(() =>
      chatLog.value.filter((entry) => entry.kind === "incoming" || entry.kind === "outgoing")
    );
    const chatEmptyMessage = computed(() => {
      const connectedPeers = meshConnectedCount.value;
      if (!isConnected.value) {
        return "Connect socket to begin.";
      }
      if (connectedPeers > 0 && chatSendMode.value === "broadcast") {
        return `Connected to ${connectedPeers} peer(s). Broadcast is ready.`;
      }
      if (!toPeer.value) {
        return connectedPeers > 0
          ? `Connected to ${connectedPeers} peer(s). Choose a peer for target mode.`
          : "Connected. Waiting for peers...";
      }
      if (dataState.value !== "open") {
        if (connectedPeers > 0) {
          return `Connected to ${connectedPeers} peer(s). Selected peer is still negotiating.`;
        }
        if (["requesting", "waiting-offer", "accepted", "offered", "answering", "answered", "connected-pending"].includes(rtcPhase.value)) {
          return "Connected to peer. Negotiating DataChannel...";
        }
        return "Peer selected. Start Auto Handshake to open the DataChannel.";
      }
      return "DataChannel is open. Send a message to start chatting.";
    });
    const fromPeerDisplay = computed(() => {
      const peer = (fromPeer.value || "").trim();
      if (!peer) {
        return "none";
      }
      if (peer.length <= 28) {
        return peer;
      }
      return `${peer.slice(0, 12)}...${peer.slice(-12)}`;
    });
    const targetPeerDisplay = computed(() => {
      const peer = (toPeer.value || "").trim();
      if (!peer) {
        return "waiting";
      }
      if (peer.length <= 28) {
        return peer;
      }
      return `${peer.slice(0, 12)}...${peer.slice(-12)}`;
    });
    const relayTargetDisplay = computed(() => {
      if (!toPeer.value) {
        return "broadcast";
      }
      return targetPeerDisplay.value;
    });
    const sendRouteDisplay = computed(() => {
      if (chatSendMode.value === "broadcast") {
        const count = meshConnectedCount.value;
        return count > 0 ? `broadcast (${count} peers)` : "broadcast (0 peers)";
      }
      return toPeer.value ? `target (${targetPeerDisplay.value})` : "target (none)";
    });
    const specWarnings = computed(() => {
      const warnings = [];
      const ws = (wsUrl.value || "").trim();
      try {
        const parsed = new URL(ws);
        if (!["ws:", "wss:"].includes(parsed.protocol)) {
          warnings.push("Signaling Server URL must use ws:// or wss://");
        }
      } catch {
        warnings.push("Signaling Server URL must be a valid absolute WebSocket URL");
      }

      const topic = (network.value || "").trim();
      if (!topic) {
        warnings.push("Room / Topic is required");
      } else if (!isSpecToken(topic)) {
        warnings.push("Room / Topic should be 1-128 chars using A-Z, a-z, 0-9, . _ : / -");
      }

      const localPeer = (fromPeer.value || "").trim();
      if (!isValidPeerId(localPeer)) {
        warnings.push("Your Peer ID should be a token-safe, fingerprint-like ID (no spaces, typically >=16 chars)");
      }

      const target = (toPeer.value || "").trim();
      if (target && !isValidPeerId(target)) {
        warnings.push("To Peer must be empty or a token-safe, fingerprint-like peer ID");
      }

      const sess = (sessionId.value || "").trim();
      if (!sess) {
        warnings.push("Session ID is required");
      } else if (!isSpecToken(sess)) {
        warnings.push("Session ID should be 1-128 chars using A-Z, a-z, 0-9, . _ : / -");
      }

      const inst = (instanceId.value || "").trim();
      if (!inst) {
        warnings.push("Instance ID is required");
      } else if (!isSpecToken(inst)) {
        warnings.push("Instance ID should be 1-128 chars using A-Z, a-z, 0-9, . _ : / -");
      }

      return warnings;
    });
    const specWarningCount = computed(() => specWarnings.value.length);
    const iAmInitiator = computed(() => {
      if (!toPeer.value || !fromPeer.value) {
        return false;
      }
      return fromPeer.value.localeCompare(toPeer.value) < 0;
    });
    const meshPeers = computed(() => {
      // Depend on mesh counters so this recomputes when link map state changes.
      void meshTargetCount.value;
      void meshConnectedCount.value;
      const isNegotiatingPhase = (phase) =>
        ["requesting", "waiting-offer", "accepted", "offered", "answering", "answered", "connected-pending", "ready"].includes(phase);

      return getVisiblePeerIds()
        .map((peerId) => {
          const link = getMeshLink(peerId, false);
          const dataStateValue = link?.dc?.readyState ?? link?.dataState ?? "closed";
          const role = fromPeer.value && peerId && fromPeer.value.localeCompare(peerId) < 0 ? "initiator" : "responder";
          const errorState = ["failed", "disconnected"].includes(link?.rtcState) || link?.phase === "rejected";
          const negotiatingState = isNegotiatingPhase(link?.phase);
          const statusTone = dataStateValue === "open" ? "ok" : errorState ? "error" : negotiatingState ? "warn" : "idle";
          const statusLabel = dataStateValue === "open" ? "connected" : errorState ? "error" : negotiatingState ? "negotiating" : "idle";
          return {
            peerId,
            display: shortPeer(peerId),
            selected: chatSendMode.value === "target" && toPeer.value === peerId,
            phase: link?.phase ?? "idle",
            rtcState: link?.rtcState ?? "new",
            dataState: dataStateValue,
            connected: dataStateValue === "open",
            role,
            statusTone,
            statusLabel
          };
        })
        .sort((left, right) => {
          if (left.selected !== right.selected) {
            return left.selected ? -1 : 1;
          }
          if (left.connected !== right.connected) {
            return left.connected ? -1 : 1;
          }
          return left.peerId.localeCompare(right.peerId);
        });
    });

    const logsText = computed(() => {
      return logs.value
        .map((entry) => {
          const payload =
            typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload, null, 2);
          return `[${entry.at}] ${entry.label}\n${payload}`;
        })
        .join("\n\n");
    });
    const logCount = computed(() => logs.value.length);
    const logPreviewEntries = computed(() => {
      return logs.value.slice(0, 4).map((entry, index) => {
        let preview = "";
        if (typeof entry.payload === "string") {
          preview = entry.payload;
        } else if (entry.payload && typeof entry.payload === "object") {
          const type = entry.payload.type;
          const from = entry.payload.from ? `from ${shortPeer(entry.payload.from)}` : "";
          const to = entry.payload.to ? `to ${shortPeer(entry.payload.to)}` : "";
          const summary = [type, from, to].filter(Boolean).join(" • ");
          preview = summary || JSON.stringify(entry.payload);
        } else {
          preview = String(entry.payload ?? "");
        }

        preview = preview.replace(/\s+/g, " ").trim();
        if (preview.length > 92) {
          preview = `${preview.slice(0, 89)}...`;
        }

        return {
          id: `${entry.at}-${entry.label}-${index}`,
          at: new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          label: entry.label,
          preview: preview || "(no payload)"
        };
      });
    });
    const logHeadline = computed(() => {
      if (!logPreviewEntries.value.length) {
        return "No events yet";
      }
      const latest = logPreviewEntries.value[0];
      return `${logCount.value} events • latest ${latest.label} @ ${latest.at}`;
    });

    function pushLog(label, payload) {
      const line = {
        at: new Date().toISOString(),
        label,
        payload
      };
      logs.value.unshift(line);
      if (logs.value.length > 200) {
        logs.value.length = 200;
      }
    }

    function pushChatMessage(text, kind = "system") {
      chatLog.value.push({
        id: newId("chat"),
        text,
        kind,
        at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
      if (chatLog.value.length > 120) {
        chatLog.value.shift();
      }
    }

    function scrollChatToLatest() {
      nextTick(() => {
        const el = chatThreadRef.value;
        if (!el) {
          return;
        }
        el.scrollTop = el.scrollHeight;
      });
    }

    watch(
      () => chatMessages.value.map((entry) => entry.id).join(","),
      () => {
        scrollChatToLatest();
      }
    );

    function shortPeer(peerId) {
      const peer = (peerId || "").trim();
      if (!peer) {
        return "none";
      }
      if (peer.length <= 22) {
        return peer;
      }
      return `${peer.slice(0, 8)}...${peer.slice(-8)}`;
    }

    function getMeshLink(peerId, create = true) {
      if (!peerId) {
        return null;
      }
      let link = meshLinks.get(peerId);
      if (!link && create) {
        link = {
          pc: null,
          dc: null,
          phase: "idle",
          rtcState: "new",
          dataState: "closed",
          connectRequested: false,
          connectRequestTime: 0,
          offerWaitTime: 0,  // Tracks when responder started waiting for offer
          answerWaitTime: 0  // Tracks when initiator started waiting for answer
        };
        meshLinks.set(peerId, link);
        refreshMeshStats();
      }
      return link || null;
    }

    function refreshMeshStats() {
      // Count only local WebRTC links with an open DataChannel.
      const openPeerIds = getVisiblePeerIds();
      meshConnectedCount.value = openPeerIds.length;
      meshTargetCount.value = openPeerIds.length;
    }

    function getVisiblePeerIds() {
      const visible = new Set();
      for (const [peerId, link] of meshLinks.entries()) {
        if (!peerId || peerId === fromPeer.value) {
          continue;
        }
        if (link?.dc?.readyState === "open") {
          visible.add(peerId);
        }
      }

      return Array.from(visible.values());
    }

    function selectedPeerId() {
      // toPeer must point to an announced peer or be empty.
      if (toPeer.value) {
        const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === toPeer.value);
        if (isAnnounced) {
          return toPeer.value;
        }
        // Stale peer reference; clear it.
        toPeer.value = "";
      }

      // If there is an active open link, prefer it for panel status.
      for (const [peerId, link] of meshLinks.entries()) {
        if (!peerId || peerId === fromPeer.value) {
          continue;
        }
        if (link?.dc?.readyState === "open") {
          return peerId;
        }
      }

      // Otherwise pick the first known non-self mesh link before falling back to peer_list.
      for (const peerId of meshLinks.keys()) {
        if (peerId && peerId !== fromPeer.value) {
          return peerId;
        }
      }

      if (discoveredPeers.value.length > 0) {
        return discoveredPeers.value[0].peer_id;
      }
      return "";
    }

    function refreshSelectedPeerSnapshot() {
      const peerId = selectedPeerId();
      if (!peerId) {
        rtcPhase.value = "idle";
        rtcState.value = "new";
        dataState.value = "closed";
        return;
      }

      const link = getMeshLink(peerId, false);
      if (!link) {
        rtcPhase.value = "idle";
        rtcState.value = "new";
        dataState.value = "closed";
        return;
      }

      rtcPhase.value = link.phase;
      rtcState.value = link.rtcState;
      dataState.value = link.dataState;
    }

    function initSharedIds() {
      const saved = safeJsonParse(localStorage.getItem(SHARED_IDS_KEY), null);
      if (saved?.session_id && saved?.instance_id) {
        sessionId.value = saved.session_id;
        instanceId.value = saved.instance_id;
        return;
      }

      sessionId.value = `sess-${Math.random().toString(36).slice(2, 10)}`;
      instanceId.value = `inst-${Math.random().toString(36).slice(2, 10)}`;
      persistSharedIds();
    }

    function persistSharedIds() {
      localStorage.setItem(
        SHARED_IDS_KEY,
        JSON.stringify({
          session_id: sessionId.value,
          instance_id: instanceId.value
        })
      );
      pushLog("ids", {
        session_id: sessionId.value,
        instance_id: instanceId.value
      });
    }

    function regenerateSharedIds() {
      sessionId.value = `sess-${Math.random().toString(36).slice(2, 10)}`;
      instanceId.value = `inst-${Math.random().toString(36).slice(2, 10)}`;
      persistSharedIds();
      pushLog("ids", "Generated new shared session_id and instance_id");
    }

    function regeneratePeerId() {
      fromPeer.value = randomHex();
      appliedFromPeer.value = fromPeer.value;
      toPeer.value = "";
      stopRtc();
      pushLog("ids", { peer_id: fromPeer.value });

      if (isConnected.value) {
        sendAnnounce();
        sendDiscover();
      }
    }

    function applyNetworkChange() {
      const next = (network.value || "").trim() || "room:test";
      const changed = next !== appliedNetwork.value;
      network.value = next;

      if (!changed) {
        return;
      }
      appliedNetwork.value = next;

      reconnectLockedByBye = false;
      byeCooldowns.clear();
      failedPeerCooldowns.clear();
      toPeer.value = "";
      discoveredPeers.value = [];

      stopAutomation();
      stopRtc();
      meshLinks.clear();
      refreshMeshStats();
      refreshSelectedPeerSnapshot();
      pushLog("network", `Switched to ${network.value}`);

      if (isConnected.value) {
        void beginRtc();
      }
    }

    function applyWsUrlChange() {
      const next = (wsUrl.value || "").trim();
      const resolved = next || `${wsScheme}://${host}/ws`;
      const changed = resolved !== appliedWsUrl.value;
      wsUrl.value = resolved;

      if (!changed) {
        return;
      }
      appliedWsUrl.value = resolved;

      pushLog("socket", `Updated signaling URL: ${wsUrl.value}`);
      if (socket.value && (socket.value.readyState === WebSocket.CONNECTING || socket.value.readyState === WebSocket.OPEN)) {
        disconnect();
        manualDisconnect = false;
        connect();
      }
    }

    function applyFromPeerChange() {
      const previous = appliedFromPeer.value;
      const next = (fromPeer.value || "").trim();
      if (!next) {
        fromPeer.value = previous;
        return;
      }

      if (!isValidPeerId(next)) {
        pushLog("ids:error", "Peer ID must be token-safe with no spaces and usually >=16 chars");
        fromPeer.value = previous;
        return;
      }

      if (next === previous) {
        fromPeer.value = previous;
        return;
      }

      fromPeer.value = next;
      appliedFromPeer.value = next;
      reconnectLockedByBye = false;
      byeCooldowns.clear();
      failedPeerCooldowns.clear();
      toPeer.value = "";
      discoveredPeers.value = [];

      stopAutomation();
      stopRtc();
      meshLinks.clear();
      refreshMeshStats();
      refreshSelectedPeerSnapshot();
      pushLog("ids", { peer_id: fromPeer.value });

      if (isConnected.value) {
        void beginRtc();
      }
    }

    function sendEnvelope(envelope) {
      if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
        pushLog("client:error", "Socket is not connected");
        return false;
      }

      // Keep network token stable even if the editable field has trailing spaces.
      const stableNetwork = normalizedNetworkValue();
      if (stableNetwork !== network.value) {
        network.value = stableNetwork;
      }

      const outbound = {
        ...envelope,
        network: stableNetwork
      };

      socket.value.send(JSON.stringify(outbound));
      pushLog("client:send", outbound);
      return true;
    }

    function sendRelayEnvelope(type, body, override = {}) {
      const hasExplicitTarget = Object.prototype.hasOwnProperty.call(override, "to");
      const target = hasExplicitTarget ? override.to : toPeer.value || null;

      if (!target && !hasExplicitTarget) {
        pushLog("client:error", "No target peer selected yet");
        return false;
      }

      return sendEnvelope({
        psp_version: PSP_VERSION,
        type,
        network: network.value,
        from: fromPeer.value,
        to: target,
        session_id: sessionId.value,
        message_id: newId(type),
        timestamp: now(),
        ttl_ms: 30000,
        body,
        ...override
      });
    }

    function connect() {
      manualDisconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const existing = socket.value;
      if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
        return;
      }
      if (!canConnect.value) {
        return;
      }

      if (existing && (existing.readyState === WebSocket.CLOSING || existing.readyState === WebSocket.CLOSED)) {
        socket.value = null;
      }

      status.value = "connecting";
      const resolvedWsUrl = normalizedWsUrlValue();
      if (resolvedWsUrl !== wsUrl.value) {
        wsUrl.value = resolvedWsUrl;
      }

      let ws;
      try {
        ws = new WebSocket(resolvedWsUrl);
      } catch (error) {
        status.value = "disconnected";
        socket.value = null;
        pushLog("socket:error", error?.message || "failed to create websocket");
        return;
      }
      socket.value = ws;

      ws.onopen = () => {
        status.value = "connected";
        pushLog("socket", `connected to ${resolvedWsUrl}`);
        // Auto-start handshake on connect
        void beginRtc();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          pushLog("server:recv", msg);
          void onServerEnvelope(msg);
        } catch {
          pushLog("server:recv", event.data);
        }
      };

      ws.onerror = () => {
        pushLog("socket:error", "WebSocket error");
        if (ws.readyState !== WebSocket.OPEN) {
          status.value = "disconnected";
        }
      };

      ws.onclose = () => {
        status.value = "disconnected";
        socket.value = null;
        stopAutoLoop();
        stopRtc();
        pushLog("socket", "closed");

        // Stay fully hands-off: reconnect automatically unless user explicitly disconnected.
        if (!manualDisconnect) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!socket.value) {
              connect();
            }
          }, 1200);
        }
      };
    }

    function disconnect() {
      manualDisconnect = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (!socket.value) {
        status.value = "disconnected";
        stopAutoLoop();
        stopRtc();
        return;
      }
      const ws = socket.value;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "client requested close");
      }
      socket.value = null;
      status.value = "disconnected";
      stopAutoLoop();
      stopRtc();
    }

    function sendAnnounce() {
      sendEnvelope({
        psp_version: PSP_VERSION,
        type: "announce",
        network: network.value,
        from: fromPeer.value,
        to: null,
        session_id: null,
        message_id: newId("announce"),
        timestamp: now(),
        ttl_ms: 30000,
        body: {
          instance_id: instanceId.value,
          roles: ["peer"],
          capabilities: {
            trickle_ice: true,
            datachannel: true,
            media: false
          },
          hints: {
            wants_peers: true,
            max_peers: 8
          }
        }
      });
    }

    function sendWithdraw() {
      sendEnvelope({
        psp_version: PSP_VERSION,
        type: "withdraw",
        network: network.value,
        from: fromPeer.value,
        to: null,
        session_id: null,
        message_id: newId("withdraw"),
        timestamp: now(),
        ttl_ms: 30000,
        body: {
          reason: "peer_offline"
        }
      });
    }

    function sendDiscover() {
      sendEnvelope({
        psp_version: PSP_VERSION,
        type: "discover",
        network: network.value,
        from: fromPeer.value,
        to: null,
        session_id: null,
        message_id: newId("discover"),
        timestamp: now(),
        ttl_ms: 30000,
        body: {
          limit: 16,
          exclude_peers: [fromPeer.value]
        }
      });
    }

    function sendPing(peerId = toPeer.value || null) {
      if (!peerId) {
        return;
      }
      sendEnvelope({
        psp_version: PSP_VERSION,
        type: "ping",
        network: network.value,
        from: fromPeer.value,
        to: peerId,
        session_id: null,
        message_id: newId("ping"),
        timestamp: now(),
        ttl_ms: 30000,
        body: {
          nonce: Math.random().toString(36).slice(2)
        }
      });
    }

    function sendRelay() {
      let body;
      try {
        body = JSON.parse(relayBody.value);
      } catch {
        pushLog("client:error", "Relay body must be valid JSON");
        return;
      }

      // Manual relay defaults to broadcast when no target peer is selected.
      sendRelayEnvelope(relayType.value, body, { to: toPeer.value || null });
    }

    function isPeerCoolingDown(peerId) {
      const expiresAt = failedPeerCooldowns.get(peerId);
      if (!expiresAt) {
        return false;
      }
      if (expiresAt <= now()) {
        failedPeerCooldowns.delete(peerId);
        return false;
      }
      return true;
    }

    function isPeerInByeCooldown(peerId) {
      const expiresAt = byeCooldowns.get(peerId);
      if (!expiresAt) {
        return false;
      }
      if (expiresAt <= now()) {
        byeCooldowns.delete(peerId);
        return false;
      }
      return true;
    }

    function markPeerFailed(peerId, reason) {
      if (!peerId) {
        return;
      }
      failedPeerCooldowns.set(peerId, now() + FAILED_PEER_COOLDOWN_MS);
      pushLog("rtc", `Peer cooldown (${reason}): ${peerId}`);
    }

    function markPeerBye(peerId, reason) {
      if (!peerId) {
        return;
      }
      byeCooldowns.set(peerId, now() + BYE_COOLDOWN_MS);
      pushLog("rtc", `Peer hold (${reason}): ${peerId}`);
    }

    function isFreshPeerAnnouncement(peer) {
      const updated = Number(peer?.timestamp || 0);
      if (!Number.isFinite(updated) || updated <= 0) {
        return false;
      }
      return now() - updated <= LIVE_PEER_MAX_AGE_MS;
    }

    function failoverFromCurrentPeer(peerId, reason) {
      if (!peerId) {
        return;
      }
      markPeerFailed(peerId, reason);
      closeMeshLink(peerId);
      if (toPeer.value === peerId) {
        toPeer.value = "";
      }
      selectNextPeerAndConnect(reason);
    }

    function selectNextPeerAndConnect(reason = "fallback") {
      const selected = choosePeerFromList(discoveredPeers.value);
      if (selected) {
        selectPeer(selected.peer_id);
        maybeAutoConnectPeer(selected.peer_id);
        return true;
      }
      pushLog("rtc", `No available peer (${reason}); requesting discover`);
      sendDiscover();
      return false;
    }

    function choosePeerFromList(peers) {
      if (!Array.isArray(peers)) {
        return null;
      }

      const candidates = peers
        .filter((peer) => peer && typeof peer.peer_id === "string" && peer.peer_id !== fromPeer.value)
        .sort((a, b) => a.peer_id.localeCompare(b.peer_id));

      const readyCandidates = candidates.filter((peer) => !isPeerCoolingDown(peer.peer_id) && !isPeerInByeCooldown(peer.peer_id));
      if (readyCandidates.length > 0) {
        // Prefer peers we can initiate with, to avoid waiting forever for a remote offer.
        const initiatorPreferred = readyCandidates.filter((peer) => fromPeer.value.localeCompare(peer.peer_id) < 0);
        if (initiatorPreferred.length > 0) {
          return initiatorPreferred[0];
        }
        return readyCandidates[0];
      }

      // All peers are in cooldown; wait for cooldown expiry instead of immediate re-trying a known busy peer.
      return null;
    }

    function selectPeer(peerId, options = {}) {
      const { manual = false, allowUnannounced = false } = options;
      
      // Only allow selecting announced peers to prevent phantom links.
      const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === peerId);
      if (!isAnnounced && !allowUnannounced) {
        pushLog("discovery:error", `Cannot select unannounced peer: ${peerId}`);
        toPeer.value = "";
        return;
      }
      
      toPeer.value = peerId;
      if (manual && !reconnectLockedByBye) {
        byeCooldowns.delete(peerId);
      }
      getMeshLink(peerId);
      refreshSelectedPeerSnapshot();
      pushLog("discovery", `Selected target peer: ${peerId}`);
    }

    function selectPeerFromUi(peerId) {
      selectPeer(peerId, { manual: true });
    }

    function startAutoLoop() {
      stopAutoLoop();

      // Send announce immediately on join.
      if (isConnected.value) {
        sendAnnounce();
      }

      // Periodic connection management: pings, auto-connect, stale pruning, and TTL keep-alive.
      discoveryTimer = setInterval(() => {
        if (!isConnected.value) {
          return;
        }

        // Keep discovery state bounded so stale peers cannot accumulate forever.
        const dedupedPeers = new Map();
        for (const peer of discoveredPeers.value) {
          const peerId = peer?.peer_id;
          if (
            typeof peerId !== "string" ||
            peerId === fromPeer.value ||
            !isValidPeerId(peerId) ||
            !isFreshPeerAnnouncement(peer)
          ) {
            continue;
          }
          dedupedPeers.set(peerId, peer);
        }
        discoveredPeers.value = Array.from(dedupedPeers.values());
        const announcedPeerIds = new Set(dedupedPeers.keys());

        for (const peerId of Array.from(meshLinks.keys())) {
          if (!peerId || peerId === fromPeer.value) continue;
          const link = getMeshLink(peerId, false);
          // Always keep open data channels.
          if (link?.dc?.readyState === "open") continue;
          // If peer withdrew (no longer in announced list), close it immediately, even if negotiating.
          if (!announcedPeerIds.has(peerId)) {
            closeMeshLink(peerId);
            meshLinks.delete(peerId);
            continue;
          }
          // Always keep in-flight negotiations for announced peers.
          if (
            link?.connectRequested ||
            ["requesting", "waiting-offer", "accepted", "offered", "answering", "answered", "connected-pending"].includes(link?.phase)
          ) continue;
          // Prune idle/dead links for still-announced peers.
          closeMeshLink(peerId);
          meshLinks.delete(peerId);
        }

        // Re-announce every 3s to keep D1 TTL alive. Server suppresses peer_list broadcasts
        // for heartbeat re-announces, so this is cheap and ensures continuous peer discovery.
        sendAnnounce();

        // Low-frequency discover keeps peer_list timestamps fresh when heartbeat broadcasts are suppressed.
        if (autoDiscovery.value && now() - lastDiscoverSyncAt >= DISCOVER_SYNC_INTERVAL_MS) {
          sendDiscover();
          lastDiscoverSyncAt = now();
        }

        const peers = discoveredPeers.value
          .map((peer) => peer?.peer_id)
          .filter((peerId) => typeof peerId === "string" && peerId !== fromPeer.value);

        for (const peerId of peers) {
          const link = getMeshLink(peerId);
          if (link.dc && link.dc.readyState === "open") {
            // Data channel is open; WebRTC keepalive handles liveness, no signaling ping needed.
            continue;
          }

          // Detect dead peers: if PC is closed/failed while still in requesting phase, mark failed immediately.
          if (
            ["requesting", "waiting-offer"].includes(link.phase) &&
            link.pc &&
            ["closed", "failed"].includes(link.pc.connectionState)
          ) {
            markPeerFailed(peerId, `pc-${link.pc.connectionState}`);
            link.connectRequested = false;
            link.phase = "idle";
            continue;
          }

          // PSP Section 11.2: Responders should timeout if initiator doesn't send offer within 10s.
          if (
            link.phase === "accepted" &&
            link.offerWaitTime &&
            now() - link.offerWaitTime > CONNECT_REQUEST_TIMEOUT_MS
          ) {
            markPeerFailed(peerId, "offer-timeout");
            link.phase = "idle";
            link.offerWaitTime = 0;
            link.connectRequested = false;
            pushLog("rtc", `${peerId} did not send offer within timeout`);
            continue;
          }

          // PSP Section 12.2: Initiators should timeout if responder doesn't send answer within 10s.
          if (
            link.phase === "offered" &&
            link.answerWaitTime &&
            now() - link.answerWaitTime > CONNECT_REQUEST_TIMEOUT_MS
          ) {
            markPeerFailed(peerId, "answer-timeout");
            link.phase = "idle";
            link.answerWaitTime = 0;
            link.connectRequested = false;
            pushLog("rtc", `${peerId} did not send answer within timeout`);
            continue;
          }

          if (
            ["requesting", "waiting-offer"].includes(link.phase) &&
            link.connectRequestTime &&
            now() - link.connectRequestTime > CONNECT_REQUEST_TIMEOUT_MS
          ) {
            markPeerFailed(peerId, "connect-timeout");
            link.connectRequested = false;
            link.connectRequestTime = 0;
            link.phase = "idle";
          }

          if (autoConnect.value) {
            maybeAutoConnectPeer(peerId);
          }
        }

        refreshSelectedPeerSnapshot();
      }, 3000);
    }

    function stopAutoLoop() {
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = null;
      }
    }

    function requestConnect(peerId) {
      if (!peerId || !isConnected.value) {
        return;
      }

      const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === peerId);
      if (!isAnnounced) {
        return;
      }

      const link = getMeshLink(peerId);
      if (!link || link.connectRequested || (link.dc && link.dc.readyState === "open")) {
        return;
      }

      // Keep one in-flight attempt state per peer until timeout/accept/reject.
      if (["requesting", "waiting-offer"].includes(link.phase)) {
        return;
      }

      link.connectRequested = true;
      link.connectRequestTime = now();
      link.phase = "requesting";
      refreshSelectedPeerSnapshot();

      const sent = sendRelayEnvelope("connect_request", {
        intent: "webrtc-datachannel",
        initiator_preference: "auto",
        roles: {
          from_role: "peer",
          requested_role: "peer"
        },
        capabilities: {
          trickle_ice: true,
          restart_ice: true,
          datachannel: true,
          media: false
        },
        topology_hints: {
          desired_link: "direct",
          priority: 10
        }
      }, { to: peerId });

      if (!sent) {
        link.connectRequested = false;
        link.phase = "idle";
      }
    }

    function maybeAutoConnectPeer(peerId) {
      if (reconnectLockedByBye || !autoConnect.value || !isConnected.value) {
        return;
      }

      if (!peerId || isPeerCoolingDown(peerId) || isPeerInByeCooldown(peerId) || peerId === fromPeer.value) {
        return;
      }

      const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === peerId);
      if (!isAnnounced) {
        return;
      }

      const link = getMeshLink(peerId);
      if (
        ["requesting", "waiting-offer", "offered", "answering", "answered", "connected-pending", "connected"].includes(link.phase) ||
        (link.pc && ["connecting", "connected"].includes(link.pc.connectionState)) ||
        (link.dc && link.dc.readyState === "open")
      ) {
        return;
      }

      requestConnect(peerId);
    }

    function closeMeshLink(peerId) {
      const link = getMeshLink(peerId, false);
      if (!link) {
        return;
      }

      // Mark idle before closing transports so close callbacks do not trigger failover.
      link.phase = "idle";
      link.connectRequested = false;
      link.connectRequestTime = 0;
      link.offerWaitTime = 0;
      link.answerWaitTime = 0;
      link.rtcState = "closed";
      link.dataState = "closed";

      if (link.dc) {
        try {
          link.dc.close();
        } catch {
          // no-op
        }
      }
      link.dc = null;

      if (link.pc) {
        try {
          link.pc.close();
        } catch {
          // no-op
        }
      }
      link.pc = null;
      refreshMeshStats();
      refreshSelectedPeerSnapshot();
    }

    function setupDataChannel(peerId, channel, source) {
      const link = getMeshLink(peerId);
      link.dc = channel;
      link.dataState = channel.readyState;
      pushLog("rtc:datachannel", `${peerId} attached (${source})`);

      if (channel.readyState === "open") {
        link.phase = "connected";
        pushLog("rtc:datachannel", `${peerId} open`);
        refreshMeshStats();
      }

      channel.onopen = () => {
        link.dataState = channel.readyState;
        link.phase = "connected";
        link.connectRequested = false;
        link.connectRequestTime = 0;
        pushLog("rtc:datachannel", `${peerId} open`);
        refreshMeshStats();
        refreshSelectedPeerSnapshot();
      };

      channel.onclose = () => {
        link.dataState = channel.readyState;
        pushLog("rtc:datachannel", `${peerId} closed`);
        refreshMeshStats();
        if (!stoppingRtc && autoConnect.value && link.phase === "connected") {
          failoverFromCurrentPeer(peerId, "datachannel-closed");
        }
        refreshSelectedPeerSnapshot();
      };

      channel.onerror = () => {
        pushLog("rtc:datachannel", `${peerId} error`);
      };

      channel.onmessage = (event) => {
        pushChatMessage(event.data, "incoming");
      };

      refreshSelectedPeerSnapshot();
    }

    function ensurePeerConnection(peerId) {
      const link = getMeshLink(peerId);
      if (link.pc) {
        return link.pc;
      }

      const peerPc = new RTCPeerConnection(RTC_CONFIG);
      link.pc = peerPc;
      link.rtcState = peerPc.connectionState;
      link.phase = "ready";

      peerPc.onconnectionstatechange = () => {
        link.rtcState = peerPc.connectionState;

        if (link.dc && link.dc.readyState === "open") {
          link.phase = "connected";
          link.connectRequested = false;
          link.connectRequestTime = 0;
        }

        pushLog("rtc:state", `${peerId} ${peerPc.connectionState}`);
        if (
          !stoppingRtc &&
          autoConnect.value &&
          ["failed", "disconnected"].includes(peerPc.connectionState) &&
          (!link.dc || link.dc.readyState !== "open")
        ) {
          failoverFromCurrentPeer(peerId, `pc-${peerPc.connectionState}`);
        }
        refreshSelectedPeerSnapshot();
      };

      peerPc.onicecandidate = (event) => {
        if (event.candidate) {
          sendRelayEnvelope("ice_candidate", { candidate: event.candidate.toJSON() }, { to: peerId });
          return;
        }
        sendRelayEnvelope("ice_end", {}, { to: peerId });
      };

      peerPc.ondatachannel = (event) => {
        setupDataChannel(peerId, event.channel, "remote-offer");
      };

      refreshSelectedPeerSnapshot();
      return peerPc;
    }

    async function startOfferFlow(peerId) {
      const peerPc = ensurePeerConnection(peerId);
      const link = getMeshLink(peerId);

      if (link.dc && link.dc.readyState === "open") {
        link.phase = "connected";
        link.connectRequested = false;
        link.connectRequestTime = 0;
        refreshSelectedPeerSnapshot();
        return;
      }

      if (!link.dc) {
        const channel = peerPc.createDataChannel("freertc");
        setupDataChannel(peerId, channel, "local-offer");
      }

      const offer = await peerPc.createOffer();
      await peerPc.setLocalDescription(offer);
      link.phase = "offered";
      link.answerWaitTime = now();  // Start timeout waiting for answer (PSP Section 12.2)

      sendRelayEnvelope(
        "offer",
        {
          sdp: offer.sdp,
          trickle_ice: true,
          restart_ice: false,
          setup_role: "actpass"
        },
        { to: peerId }
      );
      refreshSelectedPeerSnapshot();
    }

    async function beginRtc() {
      if (!isConnected.value) {
        pushLog("rtc:error", "Connect socket first");
        return;
      }

      reconnectLockedByBye = false;
      autoDiscovery.value = true;
      autoConnect.value = true;
      persistSharedIds();
      sendAnnounce();
      sendDiscover();
      lastDiscoverSyncAt = now();
      startAutoLoop();

      if (!toPeer.value) {
        rtcPhase.value = "discovering";
        pushLog("rtc", "Waiting for peer_list to select target peer");
        return;
      }

      maybeAutoConnectPeer(toPeer.value);
    }

    function stopRtc() {
      stoppingRtc = true;
      for (const peerId of meshLinks.keys()) {
        closeMeshLink(peerId);
      }

      rtcPhase.value = "idle";
      rtcState.value = "closed";
      dataState.value = "closed";
      stoppingRtc = false;
    }

    function resetRtc() {
      // Reset should start fresh by sending bye to all peers first, then clearing state.
      const peers = new Set([
        ...Array.from(meshLinks.keys()),
        ...discoveredPeers.value.map((peer) => peer?.peer_id).filter((peerId) => typeof peerId === "string")
      ]);
      for (const peerId of peers) {
        if (peerId && peerId !== fromPeer.value) {
          sendRelayEnvelope("bye", { reason: "reset_rtc" }, { to: peerId });
        }
      }

      reconnectLockedByBye = false;
      byeCooldowns.clear();
      failedPeerCooldowns.clear();
      toPeer.value = "";

      stopAutomation();
      stopRtc();

      if (isConnected.value) {
        void beginRtc();
      }
    }

    function stopAutomation() {
      autoDiscovery.value = false;
      autoConnect.value = false;
      for (const link of meshLinks.values()) {
        link.connectRequested = false;
        link.connectRequestTime = 0;
      }
      stopAutoLoop();
      pushLog("auto", "Stopped auto discovery/connect loop");
    }

    async function onServerEnvelope(message) {
      if (!message || typeof message !== "object") {
        return;
      }

      const isForMe = !message.to || message.to === fromPeer.value;
      const sameNetwork = (message.network || "").trim() === normalizedNetworkValue();
      if (!isForMe || !sameNetwork) {
        return;
      }

      if (message.type === "error") {
        pushLog("server:error", message.body || {});
        return;
      }

      if (message.type === "peer_list") {
        const peers = Array.isArray(message.body?.peers) ? message.body.peers : [];
        const deduped = new Map();
        for (const peer of peers) {
          const peerId = peer?.peer_id;
          if (
            typeof peerId !== "string" ||
            peerId === fromPeer.value ||
            !isValidPeerId(peerId) ||
            !isFreshPeerAnnouncement(peer)
          ) {
            continue;
          }
          deduped.set(peerId, peer);
        }

        discoveredPeers.value = Array.from(deduped.values());
        const announcedPeerIds = new Set(deduped.keys());

        for (const peerId of Array.from(meshLinks.keys())) {
          if (!peerId || peerId === fromPeer.value || announcedPeerIds.has(peerId)) {
            continue;
          }
          pushLog("discovery", `Pruned stale peer not in latest peer_list: ${peerId}`);
          closeMeshLink(peerId);
          meshLinks.delete(peerId);
        }

        if (toPeer.value && !announcedPeerIds.has(toPeer.value)) {
          toPeer.value = "";
        }

        const selected = choosePeerFromList(discoveredPeers.value);
        if (selected && !toPeer.value) {
          selectPeer(selected.peer_id);
        }
        if (autoConnect.value) {
          for (const peer of discoveredPeers.value) {
            maybeAutoConnectPeer(peer.peer_id);
          }
        }
        refreshMeshStats();
        refreshSelectedPeerSnapshot();
        return;
      }

      if (
        ["connect_accept", "connect_reject", "offer", "answer", "ice_candidate", "ice_end", "bye"].includes(message.type)
      ) {
        if (!message.from || message.from === fromPeer.value) {
          return;
        }
        // Accept RTC signaling even before peer_list catches up; upsert temporary discovery entry.
        const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === message.from);
        if (!isAnnounced) {
          const existingPeers = new Map(
            discoveredPeers.value
              .filter((peer) => typeof peer?.peer_id === "string")
              .map((peer) => [peer.peer_id, peer])
          );
          existingPeers.set(message.from, {
            peer_id: message.from,
            session_id: message.session_id || null,
            timestamp: now()
          });
          discoveredPeers.value = Array.from(existingPeers.values());
          pushLog("discovery", `Accepted inbound RTC peer before peer_list sync: ${message.from}`);
          refreshMeshStats();
        }
        getMeshLink(message.from);
      }

      if (message.type === "connect_request" && message.from && message.from !== fromPeer.value) {
        const isAnnounced = discoveredPeers.value.some((p) => p?.peer_id === message.from);
        if (!isAnnounced) {
          const existingPeers = new Map(
            discoveredPeers.value
              .filter((peer) => typeof peer?.peer_id === "string")
              .map((peer) => [peer.peer_id, peer])
          );
          existingPeers.set(message.from, {
            peer_id: message.from,
            session_id: message.session_id || null,
            timestamp: now()
          });
          discoveredPeers.value = Array.from(existingPeers.values());
          pushLog("discovery", `Accepted inbound peer before peer_list sync: ${message.from}`);
          refreshMeshStats();
        }
        if (!toPeer.value) {
          selectPeer(message.from, { allowUnannounced: true });
        }
      }

      if (
        message.from &&
        (reconnectLockedByBye || isPeerInByeCooldown(message.from)) &&
        ["connect_request", "connect_accept", "offer", "answer", "ice_candidate", "ice_end"].includes(message.type)
      ) {
        if (message.type === "connect_request") {
          sendRelayEnvelope(
            "connect_reject",
            {
              code: reconnectLockedByBye ? "manual_hangup_lock" : "peer_on_hold",
              reason: reconnectLockedByBye ? "manual hangup lock" : "recent bye",
              retry_after_ms: BYE_COOLDOWN_MS
            },
            { to: message.from, reply_to: message.message_id }
          );
        }
        pushLog("rtc", `Ignored ${message.type} from held peer ${message.from}`);
        return;
      }

      switch (message.type) {
        case "connect_request":
          await onConnectRequest(message);
          break;
        case "connect_accept":
          await onConnectAccept(message);
          break;
        case "connect_reject":
          onConnectReject(message);
          break;
        case "offer":
          await onOffer(message);
          break;
        case "answer":
          await onAnswer(message);
          break;
        case "ice_candidate":
          await onIceCandidate(message);
          break;
        case "ice_end":
          pushLog("rtc:ice", "remote end-of-candidates");
          break;
        case "bye":
          pushLog("rtc", `remote ended session ${message.from || "unknown"}`);
          if (message.from) {
            markPeerBye(message.from, "remote-bye");
            closeMeshLink(message.from);
          }
          if (toPeer.value === message.from) {
            toPeer.value = "";
          }
          break;
        case "ack":
        case "pong":
          break;
        default:
          break;
      }
    }

    async function onConnectRequest(message) {
      if (!message.from) {
        return;
      }

      const peerId = message.from;
      const link = getMeshLink(peerId);

       if (link.dc && link.dc.readyState === "open") {
        sendRelayEnvelope(
          "connect_reject",
          {
            code: "already_connected",
            reason: "datachannel already open"
          },
          { to: peerId, reply_to: message.message_id }
        );
        pushLog("rtc", `Ignored duplicate connect_request from connected peer ${peerId}`);
        return;
      }

      if (!toPeer.value) {
        selectPeer(peerId);
      }

      sessionId.value = message.session_id || sessionId.value;
      persistSharedIds();

      const initiator = fromPeer.value.localeCompare(peerId) < 0 ? fromPeer.value : peerId;
      sendRelayEnvelope(
        "connect_accept",
        {
          initiator_decision: initiator,
          expires_in_ms: 10000
        },
        { to: peerId, reply_to: message.message_id }
      );

      link.connectRequested = false;
      link.connectRequestTime = 0;
      link.phase = "accepted";

      if (initiator === fromPeer.value) {
        await startOfferFlow(peerId);
      }
      refreshSelectedPeerSnapshot();
    }

    async function onConnectAccept(message) {
      if (!message.from) {
        return;
      }
      const peerId = message.from;
      const link = getMeshLink(peerId);

      if (link.dc && link.dc.readyState === "open") {
        link.phase = "connected";
        link.connectRequested = false;
        link.connectRequestTime = 0;
        link.offerWaitTime = 0;
        refreshSelectedPeerSnapshot();
        return;
      }

      link.connectRequested = false;
      link.connectRequestTime = 0;
      sessionId.value = message.session_id || sessionId.value;
      persistSharedIds();

      const initiator = message.body?.initiator_decision;
      link.phase = "accepted";

      if (initiator === fromPeer.value) {
        await startOfferFlow(peerId);
      } else {
        // Responder mode: start timeout waiting for offer from initiator (PSP Section 11.2)
        link.offerWaitTime = now();
        pushLog("rtc", `Connect accepted by ${peerId}, waiting for offer from initiator`);
      }
      refreshSelectedPeerSnapshot();
    }

    function onConnectReject(message) {
      if (!message.from) {
        return;
      }
      const peerId = message.from;
      const rejectCode = message.body?.code || "connect_reject";
      const link = getMeshLink(peerId);
      link.connectRequested = false;
      link.connectRequestTime = 0;
      link.phase = "idle";
      pushLog("rtc", message.body || { code: "connect_reject" });
      markPeerFailed(peerId, `connect-reject:${rejectCode}`);
      closeMeshLink(peerId);

      if (["peer_on_hold", "manual_hangup_lock"].includes(rejectCode)) {
        markPeerBye(peerId, rejectCode);
      }

      if (toPeer.value === peerId) {
        toPeer.value = "";
      }

      if (autoConnect.value) {
        selectNextPeerAndConnect(`connect-reject:${rejectCode}`);
      }

      refreshSelectedPeerSnapshot();
    }

    async function onOffer(message) {
      if (!message.from) {
        return;
      }
      const peerId = message.from;
      const link = getMeshLink(peerId);
      if (!message.body?.sdp) {
        return;
      }
      if (link.phase === "connected" || (link.dc && link.dc.readyState === "open")) {
        pushLog("rtc", `Ignored offer from connected peer ${peerId}`);
        return;
      }

      sessionId.value = message.session_id || sessionId.value;
      persistSharedIds();

      // Responder received the offer, stop waiting timeout (PSP Section 11.2)
      link.offerWaitTime = 0;

      const peerPc = ensurePeerConnection(peerId);
      await peerPc.setRemoteDescription({ type: "offer", sdp: message.body.sdp });
      link.phase = "answering";

      const answer = await peerPc.createAnswer();
      await peerPc.setLocalDescription(answer);
      link.phase = "answered";

      sendRelayEnvelope(
        "answer",
        {
          sdp: answer.sdp,
          trickle_ice: true,
          restart_ice: false
        },
        { to: peerId, reply_to: message.message_id }
      );
      refreshSelectedPeerSnapshot();
    }

    async function onAnswer(message) {
      if (!message.from || !message.body?.sdp) {
        return;
      }
      const peerId = message.from;
      const link = getMeshLink(peerId, false);
      if (!link?.pc || link.phase === "connected") {
        return;
      }

      if (link.dc && link.dc.readyState === "open") {
        link.phase = "connected";
        link.connectRequested = false;
        link.connectRequestTime = 0;
        link.answerWaitTime = 0;
        refreshSelectedPeerSnapshot();
        return;
      }

      await link.pc.setRemoteDescription({ type: "answer", sdp: message.body.sdp });
      link.phase = "connected-pending";
      link.answerWaitTime = 0;  // Answer received, stop waiting
      pushLog("rtc", `answer applied from ${peerId}`);
      refreshSelectedPeerSnapshot();
    }

    async function onIceCandidate(message) {
      if (!message.from || !message.body?.candidate) {
        return;
      }

      const link = getMeshLink(message.from, false);
      if (!link?.pc) {
        return;
      }

      try {
        await link.pc.addIceCandidate(message.body.candidate);
      } catch (error) {
        pushLog("rtc:ice-error", error?.message || "failed to apply candidate");
      }
    }

    function sendChat() {
      const text = chatInput.value.trim();
      if (!text) {
        return;
      }

      const openLinks = Array.from(meshLinks.values()).filter((link) => link.dc && link.dc.readyState === "open");
      if (openLinks.length === 0) {
        pushLog("chat:error", "No open DataChannel");
        return;
      }

      if (chatSendMode.value === "target") {
        if (!toPeer.value) {
          pushLog("chat:error", "Target mode requires selected peer");
          return;
        }
        const selected = getMeshLink(toPeer.value, false);
        if (!selected?.dc || selected.dc.readyState !== "open") {
          pushLog("chat:error", "Selected peer DataChannel is not open");
          return;
        }
        selected.dc.send(text);
        pushChatMessage(text, "outgoing");
        chatInput.value = "";
        return;
      }

      for (const link of openLinks) {
        link.dc.send(text);
      }
      pushChatMessage(text, "outgoing");
      chatInput.value = "";
    }

    function hangup() {
      reconnectLockedByBye = true;
      const peers = new Set([
        ...Array.from(meshLinks.keys()),
        ...discoveredPeers.value.map((peer) => peer?.peer_id).filter((peerId) => typeof peerId === "string")
      ]);
      for (const peerId of peers) {
        if (peerId && peerId !== fromPeer.value) {
          markPeerBye(peerId, "local-bye");
          sendRelayEnvelope("bye", { reason: "manual_hangup" }, { to: peerId });
        }
      }
      stopAutomation();
      stopRtc();
      toPeer.value = "";
      pushLog("rtc", "sent bye and disconnected peer session");
    }

    initSharedIds();

    onMounted(() => {
      // Withdraw on page unload/reload using both beforeunload and pagehide to cover all cases.
      // Use fetch with keepalive to guarantee delivery even if socket closes immediately.
      window.addEventListener("beforeunload", () => {
        const envelope = {
          psp_version: PSP_VERSION,
          type: "withdraw",
          network: network.value || "room:test",
          from: fromPeer.value,
          to: null,
          session_id: null,
          message_id: crypto.randomUUID(),
          timestamp: Date.now(),
          ttl_ms: 30000,
          body: { reason: "peer_offline" }
        };
        // Try WebSocket first if open
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
          try {
            socket.value.send(JSON.stringify(envelope));
          } catch (e) {
            // Ignored
          }
        }
      });

      window.addEventListener("pagehide", () => {
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
          sendWithdraw();
        }
      });

      // No-click behavior: boot socket + auto-handshake loop on load.
      connect();
    });

    return {
      activeView,
      wsUrl,
      status,
      network,
      fromPeer,
      toPeer,
      sessionId,
      instanceId,
      relayType,
      relayBody,
      discoveredPeers,
      autoDiscovery,
      autoConnect,
      debugExpanded,
      logsText,
      logCount,
      logHeadline,
      logPreviewEntries,
      isConnected,
      canConnect,
      canDisconnect,
      canRunRtc,
      chatMessages,
      chatEmptyMessage,
      fromPeerDisplay,
      targetPeerDisplay,
      relayTargetDisplay,
      sendRouteDisplay,
      specWarnings,
      specWarningCount,
      meshPeers,
      meshConnectedCount,
      meshTargetCount,
      iAmInitiator,
      rtcPhase,
      rtcState,
      dataState,
      chatInput,
      chatSendMode,
      chatThreadRef,
      connect,
      disconnect,
      applyWsUrlChange,
      applyNetworkChange,
      applyFromPeerChange,
      sendAnnounce,
      sendDiscover,
      sendPing,
      sendRelay,
      beginRtc,
      stopAutomation,
      stopRtc,
      resetRtc,
      sendChat,
      hangup,
      regeneratePeerId,
      regenerateSharedIds,
      persistSharedIds,
      selectPeer,
      selectPeerFromUi
    };
  },
  template: `
    <main class="shell">
      <section class="card hero">
        <div class="hero-compact">
          <div class="brand-lockup">
            <span class="logo-badge" aria-hidden="true">
              <svg class="brand-icon" viewBox="0 0 48 48" role="img" aria-label="freertc logo">
                <circle cx="24" cy="24" r="18" fill="none" stroke="#8b5cf6" stroke-width="2.8" />
                <circle cx="24" cy="24" r="10" fill="none" stroke="#8b5cf6" stroke-width="2.4" />
                <circle cx="24" cy="24" r="3.2" fill="#8b5cf6" />
                <path d="M24 7.4v6.2" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" />
                <path d="M24 34.4v6.2" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" />
                <path d="M7.4 24h6.2" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" />
                <path d="M34.4 24h6.2" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" />
              </svg>
            </span>
            <h1 class="brand-wordmark"><span class="brand-free">free</span><span class="brand-rtc">rtc</span></h1>
          </div>
          <div class="hero-copy">PSP signaling and WebRTC data-channel mesh primitives for real-time peer networking.</div>
        </div>
        <div class="hero-status">
          <div class="status-pill" :class="status">
            <strong>{{ status }}</strong>
          </div>
          <div class="pill"><strong>mode</strong> {{ activeView === 'console' ? 'debug console' : 'auto webrtc' }}</div>
          <div class="pill"><strong>WebRTC Role</strong> {{ iAmInitiator ? 'initiator' : 'responder' }}</div>
          <div class="pill" :class="{ 'pill-warn': specWarningCount > 0 }">
            <strong>PSP Spec</strong>
            {{ specWarningCount > 0 ? specWarningCount + ' warning' + (specWarningCount === 1 ? '' : 's') : 'ok' }}
          </div>
        </div>
      </section>

      <section v-if="specWarningCount > 0" class="card spec-warning-card stack">
        <div class="section-header">
          <h2 class="panel-title">PSP Spec Warnings</h2>
          <span class="pill pill-warn"><strong>count</strong> {{ specWarningCount }}</span>
        </div>
        <ul class="spec-warning-list">
          <li v-for="warning in specWarnings" :key="warning" class="spec-warning-item">{{ warning }}</li>
        </ul>
      </section>

      <section class="headline-grid">
        <article class="card stack">
          <div class="section-header">
            <h2 class="panel-title">Session Surface</h2>
            <div class="tabs">
              <button class="tab" :class="{ active: activeView === 'webrtc' }" @click="activeView = 'webrtc'">Auto WebRTC</button>
              <button class="tab" :class="{ active: activeView === 'console' }" @click="activeView = 'console'">Console</button>
            </div>
          </div>

          <div class="info-grid">
            <div class="stat-card">
              <div class="stat-label">Signaling Server URL</div>
              <input class="stat-input mono" v-model="wsUrl" @change="applyWsUrlChange" placeholder="wss://peer.ooo/ws">
            </div>
            <div class="stat-card">
              <div class="stat-label">Room / Topic</div>
              <input class="stat-input mono" v-model="network" @change="applyNetworkChange" placeholder="room:abc">
            </div>
            <div class="stat-card">
              <div class="stat-label">Your Peer ID</div>
              <input class="stat-input mono" v-model="fromPeer" @change="applyFromPeerChange" placeholder="opaque peer id">
            </div>
          </div>

          <div class="row">
            <button @click="connect" :disabled="!canConnect">Connect</button>
            <button class="secondary" @click="disconnect" :disabled="!canDisconnect">Disconnect</button>
            <button class="secondary" @click="regeneratePeerId">New Peer ID</button>
            <button class="secondary" @click="regenerateSharedIds">New Shared IDs</button>
          </div>

          <div class="metrics">
            <dl class="metric">
              <dt>Target Peer</dt>
              <dd class="mono peer-value" :title="toPeer || ''">{{ targetPeerDisplay }}</dd>
            </dl>
            <dl class="metric">
              <dt>RTC Phase</dt>
              <dd>{{ rtcPhase }}</dd>
            </dl>
            <dl class="metric">
              <dt>PeerConnection</dt>
              <dd>{{ rtcState }}</dd>
            </dl>
            <dl class="metric">
              <dt>DataChannel</dt>
              <dd>{{ dataState }}</dd>
            </dl>
          </div>
        </article>

        <article class="card stack">
          <h2 class="panel-title">Connection Details</h2>
          <div class="field-grid">
            <label>
              WebSocket URL
              <input v-model="wsUrl" placeholder="wss://peer.ooo/ws" @change="applyWsUrlChange">
            </label>
            <label>
              Network
              <input v-model="network" placeholder="room:abc" @change="applyNetworkChange">
            </label>
            <label>
              From Peer
              <input v-model="fromPeer" @change="applyFromPeerChange">
            </label>
            <label>
              To Peer (empty = broadcast default)
              <input v-model="toPeer" placeholder="auto from peer_list if empty">
            </label>
          </div>
          <div class="row">
            <span class="pill"><strong>manual relay</strong> {{ relayTargetDisplay }}</span>
            <span class="pill"><strong>mesh</strong> {{ meshConnectedCount }}/{{ meshTargetCount }} connected</span>
          </div>
          <div class="field-grid">
            <label>
              Session ID
              <input v-model="sessionId" @change="persistSharedIds">
            </label>
            <label>
              Instance ID
              <input v-model="instanceId" @change="persistSharedIds">
            </label>
          </div>
          <div class="row">
            <button @click="sendAnnounce" :disabled="!isConnected">announce</button>
            <button class="secondary" @click="sendDiscover" :disabled="!isConnected">discover</button>
            <button class="secondary" @click="sendPing" :disabled="!isConnected">ping</button>
          </div>
        </article>
      </section>

      <section class="control-grid">
        <article v-if="activeView === 'console'" class="card console-card stack">
          <div class="section-header">
            <h2 class="panel-title">Raw Relay Console</h2>
            <span class="pill"><strong>psp</strong> manual envelope mode</span>
            <span class="pill"><strong>to</strong> {{ relayTargetDisplay }}</span>
          </div>
          <label>
            Relay Type
            <select v-model="relayType">
              <option>announce</option>
              <option>discover</option>
              <option>ping</option>
              <option>connect_request</option>
              <option>connect_accept</option>
              <option>connect_reject</option>
              <option>offer</option>
              <option>answer</option>
              <option>ice_candidate</option>
              <option>ice_end</option>
              <option>renegotiate</option>
              <option>bye</option>
              <option>ext</option>
            </select>
          </label>

          <label>
            Body (JSON)
            <textarea v-model="relayBody"></textarea>
          </label>

          <div class="row">
            <button @click="sendRelay" :disabled="!isConnected">Send Relay Message</button>
          </div>

          <p class="muted">Send protocol frames directly when you need to inspect or force specific signaling behavior.</p>
        </article>

        <article v-else class="card stack">
          <div class="section-header">
            <h2 class="panel-title">Auto Handshake</h2>
            <span class="pill"><strong>peers</strong> {{ meshConnectedCount }}</span>
            <span class="pill"><strong>route</strong> {{ sendRouteDisplay }}</span>
          </div>

          <p class="muted">Auto mode runs peer discovery, target selection, and WebRTC negotiation using the shared session and instance identifiers across tabs. Chat is broadcast by default.</p>

          <div class="row">
            <button @click="beginRtc" :disabled="!canRunRtc">Start Auto Handshake</button>
            <button
              class="secondary"
              :class="{ active: !autoDiscovery && !autoConnect }"
              @click="stopAutomation"
            >
              Stop Auto Discovery/Connect
            </button>
            <button class="secondary" @click="hangup" :disabled="!canRunRtc">Send bye</button>
            <button class="secondary" @click="resetRtc">Reset RTC</button>
          </div>

          <div class="runtime-strip">
            <article class="runtime-chip" :class="autoDiscovery ? 'ok' : 'idle'">
              <div class="runtime-label">Auto Discovery</div>
              <div class="runtime-value">{{ autoDiscovery ? 'On' : 'Off' }}</div>
            </article>
            <article class="runtime-chip" :class="autoConnect ? 'ok' : 'idle'">
              <div class="runtime-label">Auto Connect</div>
              <div class="runtime-value">{{ autoConnect ? 'On' : 'Off' }}</div>
            </article>
            <article class="runtime-chip" :class="iAmInitiator ? 'warn' : 'idle'">
              <div class="runtime-label">WebRTC Role</div>
              <div class="runtime-value">{{ iAmInitiator ? 'Initiator' : 'Responder' }}</div>
            </article>
            <article class="runtime-chip selected">
              <div class="runtime-label">Send Route</div>
              <div class="runtime-value mono runtime-route-value" :title="chatSendMode === 'target' ? (toPeer || '') : ''">{{ sendRouteDisplay }}</div>
            </article>
          </div>

          <div ref="chatThreadRef" class="chat-thread" v-if="chatMessages.length">
            <div
              v-for="entry in chatMessages"
              :key="entry.id"
              class="chat-row"
              :class="entry.kind"
            >
              <article class="chat-bubble">
                <div class="chat-meta">{{ entry.kind === 'outgoing' ? 'you' : 'peer' }} · {{ entry.at }}</div>
                <div class="chat-body">{{ entry.text }}</div>
              </article>
            </div>
          </div>
          <div v-else class="chat-empty">{{ chatEmptyMessage }}</div>

          <section class="chat-composer stack">
            <label class="chat-label">
              Message
              <input v-model="chatInput" placeholder="Write a message" @keyup.enter="sendChat">
            </label>

            <div class="chat-toolbar">
              <div class="mode-toggle" role="group" aria-label="Chat send mode">
                <button
                  class="mode-btn"
                  :class="{ active: chatSendMode === 'broadcast' }"
                  :aria-pressed="chatSendMode === 'broadcast'"
                  @click="chatSendMode = 'broadcast'"
                >
                  Broadcast
                </button>
                <button
                  class="mode-btn"
                  :class="{ active: chatSendMode === 'target' }"
                  :aria-pressed="chatSendMode === 'target'"
                  @click="chatSendMode = 'target'"
                >
                  Selected only
                </button>
              </div>
              <button class="chat-send-btn" @click="sendChat">Send</button>
            </div>

            <p class="mode-indicator">
              {{ chatSendMode === 'broadcast'
                ? 'Broadcast to ' + meshConnectedCount + ' connected peer' + (meshConnectedCount === 1 ? '' : 's')
                : 'Selected route: ' + targetPeerDisplay }}
            </p>
          </section>
        </article>

        <div class="sidebar-stack">
          <article class="card stack">
            <div class="section-header">
              <h2 class="panel-title">Mesh Peers</h2>
              <span class="pill"><strong>links</strong> {{ meshConnectedCount }}/{{ meshTargetCount }}</span>
            </div>
            <p class="muted mesh-helper">Click any peer row to set selected target when mode is Selected only.</p>

            <div v-if="meshPeers.length" class="mesh-list">
              <button
                v-for="peer in meshPeers"
                :key="peer.peerId"
                class="mesh-row"
                :class="{ 'is-selected': peer.selected, 'is-connected': peer.connected }"
                @click="selectPeerFromUi(peer.peerId)"
              >
                <span class="mesh-main">
                  <span class="mesh-peer-row">
                    <span class="mesh-peer mono" :title="peer.peerId">{{ peer.display }}</span>
                    <span class="mesh-badges">
                      <span class="mesh-badge mesh-role" :class="peer.role">{{ peer.role }}</span>
                      <span class="mesh-badge" :class="peer.statusTone">{{ peer.statusLabel }}</span>
                    </span>
                  </span>
                  <span class="mesh-state-line">{{ peer.phase }} • RTC {{ peer.rtcState }} • DC {{ peer.dataState }}</span>
                </span>
              </button>
            </div>
            <div v-else class="chat-empty mesh-empty">No peers announced yet.</div>
          </article>

          <article class="card debug-card stack">
            <div class="section-header">
              <h2 class="panel-title">Debug Log</h2>
              <div class="row">
                <span class="pill"><strong>rtc</strong> newest first</span>
                <span class="pill"><strong>events</strong> {{ logCount }}</span>
                <button class="secondary" @click="debugExpanded = !debugExpanded">{{ debugExpanded ? 'Hide log' : 'Show log' }}</button>
              </div>
            </div>
            <div v-if="debugExpanded" class="log">{{ logsText }}</div>
            <div v-else class="log-preview">
              <div class="log-preview-head">{{ logHeadline }}</div>
              <ul v-if="logPreviewEntries.length" class="log-preview-list">
                <li v-for="entry in logPreviewEntries" :key="entry.id" class="log-preview-item">
                  <span class="log-preview-time">{{ entry.at }}</span>
                  <span class="log-preview-label">{{ entry.label }}</span>
                  <span class="log-preview-text">{{ entry.preview }}</span>
                </li>
              </ul>
              <p v-else class="muted">No log events yet.</p>
            </div>
          </article>
        </div>
      </section>

      <section class="card footer-note muted">
        <div>freertc · generic realtime signaling console</div>
        <div>Worker endpoint: <code>{{ wsUrl }}</code></div>
      </section>
    </main>
  `
}).mount("#app");
