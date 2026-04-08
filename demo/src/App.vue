<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted } from 'vue'
import P2pPeer from './components/P2pPeer.vue'
import { useP2p } from './composables/useP2p.js'
import { sha256, randomTopic } from './utils/topic.js'

// ── shared reactive state ─────────────────────────────────────────────────
const tech        = 'raw'
const serverUrl   = ref(typeof window !== 'undefined' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` : '')
const topicName   = ref(readRoomFromUrl() || randomTopic())
const topicHash   = ref('')
const isInitiator = ref(false)  // unused, kept for API compat
const sharedMagnet = ref('')
const ROOM_PARAM = 'room'

// Recompute SHA-256 when topic name changes
watchEffect(() => {
  const name = topicName.value.trim()
  if (!name) {
    topicHash.value = ''
    return
  }

  sha256(name)
    .then((hash) => {
      topicHash.value = hash
    })
    .catch(() => {
      topicHash.value = ''
    })
})

// Reset shared magnet when topic changes
watchEffect(() => {
  void topicHash.value
  sharedMagnet.value = ''
})

function setRandomTopic() {
  topicName.value = randomTopic()
}

function readRoomFromUrl() {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  return params.get(ROOM_PARAM)?.trim() ?? ''
}

function writeRoomToUrl(room) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const value = String(room || '').trim()

  if (value) url.searchParams.set(ROOM_PARAM, value)
  else url.searchParams.delete(ROOM_PARAM)

  const nextUrl = `${url.pathname}${url.search}${url.hash}`
  window.history.replaceState(null, '', nextUrl)
}

onMounted(() => {})

watch(topicName, (nextRoom) => {
  writeRoomToUrl(nextRoom)
}, { immediate: true })

onUnmounted(() => {})

// ── peer ID (stable per session) ──────────────────────────────────────────
function genId() {
  const webCrypto = globalThis.window?.crypto ?? globalThis.crypto
  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(32)
    webCrypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  let out = ''
  while (out.length < 64) {
    out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}
const myPeerId = ref(genId())

// ── P2P composable ────────────────────────────────────────────────────────
const p2p = useP2p({
  tech,
  serverUrl,
  topicHash,
  peerId:      myPeerId,
  isInitiator,
  sharedMagnet,
  onShare: () => {},
})

// ── validation ────────────────────────────────────────────────────────────
const canConnect = computed(() => serverUrl.value.trim() !== '' && topicHash.value !== '')
</script>

<template>
  <div class="layout">
    <!-- ── header ──────────────────────────────────────────────────────── -->
    <header class="site-header">
      <div class="inner">
        <div class="logo">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="12" cy="12" r="4"  stroke="currentColor" stroke-width="1.5"/>
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>free<span class="accent">rtc</span></span>
        </div>

      </div>
    </header>

    <!-- ── main ────────────────────────────────────────────────────────── -->
    <main class="content">

      <!-- ── shared configuration ────────────────────────────────────── -->
      <div class="config-card">
        <div class="config-grid">
          <!-- server URL -->
          <div class="field">
            <label class="field-label" for="server-url">Signaling Server URL</label>
            <input
              id="server-url"
              v-model="serverUrl"
              type="text"
              placeholder="wss://your-domain.example/ws"
              spellcheck="false"
            />
          </div>

          <!-- room topic -->
          <div class="field">
            <label class="field-label" for="topic-name">Room / Topic</label>
            <div class="topic-row">
              <input
                id="topic-name"
                v-model="topicName"
                type="text"
                placeholder="e.g. my-test-room"
                spellcheck="false"
              />
              <button class="btn-ghost" title="Random topic" @click="setRandomTopic">🎲</button>
            </div>
            <p v-if="topicHash" class="hash-display">
              SHA-256 → <code>{{ topicHash }}</code>
            </p>
            <p v-else class="hash-hint">Enter a room name to generate a topic hash.</p>
          </div>
        </div>

        <p v-if="!canConnect" class="config-warning">
          ⚠ Enter a server URL and room topic before connecting.
        </p>
      </div>

      <!-- ── single peer panel ──────────────────────────────────────── -->
      <P2pPeer
        label="Peer"
        :peer-id="myPeerId"
        :tech="tech"
        :status="p2p.status.value"
        :logs="p2p.logs.value"
        :messages="p2p.messages.value"
        :peer-count="p2p.peerCount.value"
        :connect="p2p.connect"
        :disconnect="p2p.disconnect"
        :send="p2p.send"
        :clear-logs="p2p.clearLogs"
        :clear-messages="p2p.clearMessages"
      />


    </main>

    <!-- ── footer ──────────────────────────────────────────────────────── -->
    <footer class="site-footer">
      <p>freertc &nbsp;·&nbsp; Deployed on <a href="https://workers.cloudflare.com" target="_blank" rel="noopener">Cloudflare Workers</a></p>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ── header ─────────────────────────────────────────────────────────────── */
.site-header {
  border-bottom: 1px solid var(--color-border);
  padding: 1rem 1.5rem;
}

.inner {
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 1.2rem;
  flex-wrap: wrap;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.2rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  flex-shrink: 0;
  color: var(--color-text);
}
.logo svg { color: var(--color-accent); }
.accent   { color: var(--color-accent); }

.tagline {
  color: var(--color-text-muted);
  font-size: 0.88rem;
}

/* ── main ───────────────────────────────────────────────────────────────── */
.content {
  flex: 1;
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

/* ── tech tabs ──────────────────────────────────────────────────────────── */
.tech-tabs {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.tab {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  border-radius: var(--radius);
  padding: 0.4rem 1rem;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.tab:hover { color: var(--color-text); border-color: var(--color-text-muted); }
.tab.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #fff;
}

.tech-desc {
  font-size: 0.88rem;
  color: var(--color-text-muted);
  line-height: 1.55;
}

/* ── config card ────────────────────────────────────────────────────────── */
.config-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1.1rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

@media (max-width: 680px) {
  .config-grid { grid-template-columns: 1fr; }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field-label {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.topic-row {
  display: flex;
  gap: 0.4rem;
}
.topic-row input { flex: 1; }

.hash-display {
  font-size: 0.73rem;
  color: var(--color-text-muted);
  word-break: break-all;
}
.hash-display code {
  color: var(--color-accent);
  font-family: var(--font-mono);
}

.hash-hint { font-size: 0.73rem; color: var(--color-text-muted); font-style: italic; }

.config-warning {
  font-size: 0.82rem;
  color: var(--color-warn);
  background: #3b2f0022;
  border: 1px solid #f59e0b44;
  border-radius: var(--radius);
  padding: 0.45rem 0.75rem;
}

/* ── buttons (config area) ──────────────────────────────────────────────── */
.btn-ghost {
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 0.3rem 0.65rem;
  font-size: 0.88rem;
  cursor: pointer;
}
.btn-ghost:hover { color: var(--color-text); border-color: var(--color-text-muted); }

/* ── peers grid ─────────────────────────────────────────────────────────── */
.peers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.1rem;
  align-items: start;
}

@media (max-width: 720px) {
  .peers { grid-template-columns: 1fr; }
}

/* ── protocol reference ─────────────────────────────────────────────────── */
.protocol-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
}

.protocol-summary {
  padding: 0.7rem 1.1rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.protocol-summary::before {
  content: '▶';
  font-size: 0.7rem;
  transition: transform 0.15s;
}
details[open] .protocol-summary::before { transform: rotate(90deg); }
.protocol-summary:hover { color: var(--color-text); }

.protocol-code {
  margin: 0;
  padding: 0.85rem 1.1rem 1rem;
  border-top: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-text-muted);
  white-space: pre;
  overflow-x: auto;
  line-height: 1.6;
  background: var(--color-bg);
}

/* ── how-to ─────────────────────────────────────────────────────────────── */
.how-to {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1rem 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.how-to h3 {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.how-to ol {
  padding-left: 1.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.88rem;
}

/* ── footer ─────────────────────────────────────────────────────────────── */
.site-footer {
  border-top: 1px solid var(--color-border);
  padding: 0.8rem 1.5rem;
  text-align: center;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
</style>
