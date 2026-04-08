<script setup>
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  label:         { type: String,   required: true },
  peerId:        { type: String,   default: '' },
  tech:          { type: String,   default: 'raw' },
  status:        { type: String,   default: 'disconnected' },
  logs:          { type: Array,    default: () => [] },
  messages:      { type: Array,    default: () => [] },
  peerCount:     { type: Number,   default: 0 },
  connect:       { type: Function, required: true },
  disconnect:    { type: Function, required: true },
  send:          { type: Function, required: true },
  clearLogs:     { type: Function, required: true },
  clearMessages: { type: Function, required: true },
})

const message = ref('')
const chatEl  = ref(null)
const inputEl = ref(null)
const logsEl  = ref(null)

const isConnected  = computed(() => props.status === 'connected')
const isConnecting = computed(() => props.status === 'connecting')
const hasSend      = computed(() => true)
const canSend      = computed(() => isConnected.value && message.value.trim() !== '')

const statusLabel = computed(() => ({
  disconnected: 'Disconnected',
  connecting:   'Connecting…',
  connected:    'Connected',
  error:        'Error',
}[props.status] ?? props.status))

function handleSend() {
  if (!canSend.value) return
  props.send(message.value.trim())
  message.value = ''
  nextTick(() => {
    if (inputEl.value) {
      inputEl.value.style.height = 'auto'
      inputEl.value.focus()
    }
  })
}

function handleKeydown(evt) {
  if (evt.key === 'Enter' && !evt.shiftKey) {
    evt.preventDefault()
    handleSend()
  }
}

function autoResize(evt) {
  const el = evt.target
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

// Auto-scroll chat on new messages
watch(
  () => props.messages.length,
  () => nextTick(() => {
    if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
  }),
)

// Auto-scroll log when new entries arrive
watch(
  () => props.logs.length,
  () => nextTick(() => {
    if (logsEl.value) logsEl.value.scrollTop = logsEl.value.scrollHeight
  }),
)
</script>

<template>
  <section class="panel">

    <!-- ── header ─────────────────────────────────────────────────────── -->
    <div class="panel-header">
      <div class="hd-left">
        <span class="badge" :class="status">{{ statusLabel }}</span>
        <span v-if="isConnected && peerCount > 0" class="peer-count">
          {{ peerCount }} peer{{ peerCount !== 1 ? 's' : '' }} connected
        </span>
      </div>
      <div class="hd-right">
        <button
          v-if="!isConnected && !isConnecting"
          class="btn btn-primary"
          @click="connect"
        >Connect</button>
        <button v-else class="btn btn-danger" @click="disconnect">Disconnect</button>
      </div>
    </div>

    <!-- ── peer id ────────────────────────────────────────────────────── -->
    <div v-if="peerId" class="peer-id-row">
      <span class="peer-id-label">Your peer ID</span>
      <code class="peer-id-value">{{ peerId }}</code>
    </div>

    <!-- ── chat window ────────────────────────────────────────────────── -->
    <div v-if="hasSend" ref="chatEl" class="chat">
      <div v-if="messages.length === 0" class="chat-empty">
        <span v-if="isConnected">Say something to the other peer…</span>
        <span v-else-if="isConnecting">Connecting…</span>
        <span v-else>Connect to start chatting</span>
      </div>

      <div
        v-for="msg in messages"
        :key="msg.id"
        class="bubble-row"
        :class="msg.from"
      >
        <div class="bubble">
          <p class="bubble-text">{{ msg.text }}</p>
          <span class="bubble-ts">{{ msg.ts }}</span>
        </div>
      </div>
    </div>

    <!-- ── input bar ──────────────────────────────────────────────────── -->
    <div v-if="hasSend" class="input-bar">
      <textarea
        ref="inputEl"
        v-model="message"
        rows="1"
        :placeholder="isConnected ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Connect first…'"
        :disabled="!isConnected"
        spellcheck="false"
        aria-label="Chat message"
        @keydown="handleKeydown"
        @input="autoResize"
      />
      <button class="btn-send" :disabled="!canSend" title="Send" @click="handleSend">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <!-- ── debug log (collapsible) ────────────────────────────────────── -->
    <details class="log-details">
      <summary class="log-summary">
        Debug log
        <span v-if="logs.length" class="log-count">{{ logs.length }}</span>
        <button class="btn-ghost-sm" @click.stop="clearLogs">Clear</button>
      </summary>
      <div ref="logsEl" class="log">
        <p v-if="logs.length === 0" class="log-empty">No events.</p>
        <div
          v-for="entry in logs"
          :key="entry.id"
          class="log-entry"
          :class="entry.type"
        >
          <span class="col-ts">{{ entry.ts }}</span>
          <span class="col-type">{{ entry.type }}</span>
          <span class="col-text">{{ entry.text }}</span>
        </div>
      </div>
    </details>

  </section>
</template>

<style scoped>
/* ── panel ──────────────────────────────────────────────────────────────── */
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── header ─────────────────────────────────────────────────────────────── */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.hd-left { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
.hd-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }

.badge {
  padding: 0.22rem 0.7rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.badge.disconnected { background: #2a2a2a; color: var(--color-text-muted); }
.badge.connecting   { background: #3b2f00; color: var(--color-warn); }
.badge.connected    { background: #0d2e1a; color: var(--color-success); }
.badge.error        { background: #2e0d0d; color: var(--color-error); }

.role-tag {
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--color-text-muted);
  padding: 0.15rem 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.peer-count { font-size: 0.8rem; color: var(--color-success); }

/* ── peer id ─────────────────────────────────────────────────────────────── */
.peer-id-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.38rem 1.1rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}

.peer-id-label {
  font-size: 0.68rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 700;
  flex-shrink: 0;
}

.peer-id-value {
  font-family: var(--font-mono);
  font-size: 0.69rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── buttons ─────────────────────────────────────────────────────────────── */
.btn {
  border-radius: var(--radius);
  padding: 0.42rem 1.1rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.btn-primary { background: var(--color-accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
.btn-danger  { background: var(--color-error);  color: #fff; }
.btn-danger:hover  { opacity: 0.85; }

/* ── wt note ─────────────────────────────────────────────────────────────── */
.wt-note {
  font-size: 0.84rem;
  color: var(--color-text-muted);
  font-style: italic;
  padding: 0.7rem 1.1rem;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* ── chat window ─────────────────────────────────────────────────────────── */
.chat {
  flex: 1;
  min-height: 360px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  scroll-behavior: smooth;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 0.88rem;
  font-style: italic;
  text-align: center;
  padding: 3rem 0;
}

/* ── message bubbles ─────────────────────────────────────────────────────── */
.bubble-row {
  display: flex;
  animation: fadeIn 0.15s ease;
}
.bubble-row.me   { justify-content: flex-end; }
.bubble-row.them { justify-content: flex-start; }

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.bubble {
  max-width: min(72%, 520px);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.bubble-row.me .bubble   { align-items: flex-end; }
.bubble-row.them .bubble { align-items: flex-start; }

.bubble-text {
  margin: 0;
  padding: 0.55rem 0.9rem;
  border-radius: 1.1rem;
  font-size: 0.94rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble-row.me .bubble-text {
  background: var(--color-accent);
  color: #fff;
  border-bottom-right-radius: 0.3rem;
}

.bubble-row.them .bubble-text {
  background: #242424;
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-bottom-left-radius: 0.3rem;
}

.bubble-ts {
  font-size: 0.65rem;
  color: var(--color-text-muted);
  padding: 0 0.2rem;
}

/* ── input bar ───────────────────────────────────────────────────────────── */
.input-bar {
  display: flex;
  align-items: flex-end;
  gap: 0.55rem;
  padding: 0.65rem 1.1rem;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-surface);
}

.input-bar textarea {
  flex: 1;
  resize: none;
  border-radius: var(--radius);
  font-size: 0.92rem;
  line-height: 1.5;
  padding: 0.5rem 0.75rem;
  max-height: 120px;
  overflow-y: auto;
}

.btn-send {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  background: var(--color-accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.12s;
}
.btn-send:not(:disabled):hover { opacity: 0.85; }
.btn-send:disabled { opacity: 0.3; cursor: default; }

/* ── debug log ───────────────────────────────────────────────────────────── */
.log-details {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
}

.log-summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.1rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  user-select: none;
}
.log-summary::-webkit-details-marker { display: none; }
.log-summary::before {
  content: '▶';
  font-size: 0.6rem;
  transition: transform 0.15s;
}
details[open] .log-summary::before { transform: rotate(90deg); }

.log-count {
  background: #2a2a2a;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0 0.42rem;
  font-size: 0.65rem;
}

.btn-ghost-sm {
  margin-left: auto;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 0.1rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  font-weight: 600;
}
.btn-ghost-sm:hover { color: var(--color-text); border-color: var(--color-text-muted); }

.log {
  background: var(--color-bg);
  padding: 0.5rem 1.1rem 0.8rem;
  font-family: var(--font-mono);
  font-size: 0.73rem;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
}

.log-empty { color: var(--color-text-muted); font-style: italic; }

.log-entry {
  display: grid;
  grid-template-columns: 5.5rem 4rem 1fr;
  gap: 0.4rem;
  word-break: break-all;
  line-height: 1.45;
}

.col-ts   { color: var(--color-text-muted); }
.col-type { font-weight: 700; }

.log-entry.info    .col-type { color: var(--color-text-muted); }
.log-entry.success .col-type { color: var(--color-success); }
.log-entry.warn    .col-type { color: var(--color-warn); }
.log-entry.error   .col-type { color: var(--color-error); }
.log-entry.send    .col-type { color: var(--color-accent); }
.log-entry.recv    .col-type { color: #34d399; }
</style>
