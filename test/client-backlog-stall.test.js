import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 30))

function harness(localPeerId) {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    constructor() { this.readyState = FakeWebSocket.CONNECTING; this.sent = []; sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code }) }
  }
  class FakeDataChannel {
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.sent = [] }
    send(value) { if (this.readyState !== 'open') throw new Error('InvalidStateError'); let parsed = value; try { parsed = JSON.parse(value) } catch {} this.sent.push(parsed) }
    deliver(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    open() { this.readyState = 'open'; this.onopen?.() }
    close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.() }
  }
  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'; this.connectionState = 'connected'; this.iceConnectionState = 'connected'
      this.iceGatheringState = 'complete'; this.localDescription = null; this.remoteDescription = null
      this.channels = []
      peerConnections.push(this)
    }
    addTransceiver() {}
    createDataChannel(label) { const channel = new FakeDataChannel(label); this.channels.push(channel); return channel }
    async createOffer() { return { type: 'offer', sdp: `v=0\r\na=ice-ufrag:${localPeerId}\r\n` } }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:ans\r\n' } }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable' }
    async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
    async addIceCandidate() {}
    addEventListener() {}
    removeEventListener() {}
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; this.onconnectionstatechange?.() }
  }
  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  const client = createSignalingClient({
    peerId: localPeerId, networkId: 'test-network', roomId: 'test-room',
    signalUrl: 'wss://signal.example/ws', autoConnect: false, onLog: (m) => logs.push(m),
  })
  client.connect()
  const socket = sockets[0]
  socket.open()
  socket.receive({ type: 'ack', body: { status: 'ok' } })
  const restore = () => {
    client.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
  return { client, socket, peerConnections, logs, restore }
}

async function openProvenChannel(h) {
  await h.client.initiateConnection('z-remote')
  h.socket.receive({ type: 'answer', from: 'z-remote', session_id: 'test-room', body: { sdp: 'v=0\r\na=ice-ufrag:r1\r\n' } })
  await nextTurn()
  const channel = h.peerConnections[0].channels[0]
  channel.open()
  await nextTurn()
  channel.deliver({ type: 'pong', ts: Date.now() })
  return channel
}

test('a send buffer past the cap is refused as transient backpressure', async () => {
  const h = harness('a-local')
  try {
    const channel = await openProvenChannel(h)
    h.client.sendData('hello', 'z-remote')
    assert.ok(channel.sent.includes('hello'), 'a normal send goes through')
    channel.bufferedAmount = 5 * 1024 * 1024
    assert.throws(() => h.client.sendData('more', 'z-remote'), (error) => error.transient === true && /send buffer is full/.test(error.message))
    channel.bufferedAmount = 0
    h.client.sendData('again', 'z-remote')
  } finally {
    h.restore()
  }
})

test('a backlog that stops draining is executed at the stall window instead of living forever', async (t) => {
  const h = harness('a-local')
  try {
    const channel = await openProvenChannel(h)
    // A ping goes out and the buffer fills; it never shrinks again.
    channel.deliver({ type: 'message', n: 1 })
    channel.bufferedAmount = 2 * 1024 * 1024
    const realNow = Date.now
    const base = realNow()
    let offset = 0
    Date.now = () => base + offset
    try {
      for (let i = 1; i <= 24; i++) {
        offset = i * 1000
        await new Promise((resolve) => setTimeout(resolve, 1050))
        if (h.logs.some((m) => m.includes('backlog stalled'))) break
      }
    } finally {
      Date.now = realNow
    }
    assert.ok(h.logs.some((m) => m.includes('data channel backlog stalled')), h.logs.slice(-6).join('\n'))
    assert.equal(channel.readyState, 'closed')
  } finally {
    h.restore()
  }
})
