import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 30))

// A werift peer can deliver the remote's arming ping on a channel that still
// reports 'connecting'. The pong is owed at open, and an unanswered ping is
// re-sent rather than left to expire.
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
    send(value) { if (this.readyState !== 'open') throw new Error('InvalidStateError'); this.sent.push(JSON.parse(value)) }
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

test('a ping that lands while the channel is still connecting is answered at open', async () => {
  const h = harness('a-local')
  try {
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    const channel = pc.channels[0]
    assert.equal(channel.readyState, 'connecting')
    channel.deliver({ type: 'ping', ts: Date.now() })
    assert.equal(channel.sent.length, 0, 'nothing can be sent before open')
    channel.open()
    await nextTurn()
    const types = channel.sent.map((m) => m.type)
    assert.ok(types.includes('pong'), `the owed pong is sent at open: ${types.join(',')}`)
    assert.ok(!h.logs.some((m) => m.includes('closing peer connection')), h.logs.join('\n'))
  } finally {
    h.restore()
  }
})

test('an unanswered ping is re-sent after the retry interval while the channel is alive', async () => {
  const realNow = Date.now
  const h = harness('a-local')
  try {
    await h.client.initiateConnection('z-remote')
    h.socket.receive({ type: 'answer', from: 'z-remote', session_id: 'test-room', body: { sdp: 'v=0\r\na=ice-ufrag:r1\r\n' } })
    await nextTurn()
    const pc = h.peerConnections[0]
    const channel = pc.channels[0]
    channel.open()
    await nextTurn()
    const pingsAfterOpen = channel.sent.filter((m) => m.type === 'ping').length
    assert.equal(pingsAfterOpen, 1, 'one arming ping at open')
    // Six seconds pass with no pong. The keepalive tick runs every second.
    const base = realNow()
    let offset = 0
    Date.now = () => base + offset
    for (let i = 1; i <= 7; i++) {
      offset = i * 1000
      await new Promise((resolve) => setTimeout(resolve, 1050))
    }
    const pings = channel.sent.filter((m) => m.type === 'ping').length
    assert.ok(pings >= 2, `the ping was re-sent (${pings} sent)`)
    assert.ok(!h.logs.some((m) => m.includes('closing peer connection')), 'no verdict inside the retry window')
  } finally {
    Date.now = realNow
    h.restore()
  }
})
