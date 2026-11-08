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
  const received = []
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
    onDataMessage: (m) => received.push(m),
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
  return { client, socket, peerConnections, logs, received, restore }
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


test('bytes go as binary frames of at most 48 KiB, and come back whole as one Uint8Array', async () => {
  const h = harness('a-local')
  try {
    const channel = await openProvenChannel(h)
    const bytes = new Uint8Array(131072 + 777)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255
    channel.sent.length = 0
    h.client.sendData(bytes, 'z-remote')
    const frames = channel.sent.filter((f) => ArrayBuffer.isView(f))
    assert.equal(frames.length, 3, 'three frames for 128.8 KiB')
    assert.ok(frames.every((f) => f.byteLength <= 48 * 1024 + 12))
    // The frames arrive (out of order too): one message, the bytes as sent.
    for (const f of [frames[2], frames[0], frames[1]]) channel.onmessage({ data: f })
    const got = h.received.filter((m) => m.data instanceof Uint8Array)
    assert.equal(got.length, 1)
    assert.deepEqual(got[0].data, bytes)
    // A small one: a single frame.
    h.client.sendData(new Uint8Array([1, 2, 3]), 'z-remote')
    const one = channel.sent.filter((f) => ArrayBuffer.isView(f)).at(-1)
    channel.onmessage({ data: one })
    assert.deepEqual(h.received.filter((m) => m.data instanceof Uint8Array).at(-1).data, new Uint8Array([1, 2, 3]))
    // Strings still go as before.
    h.client.sendData('hello', 'z-remote')
    assert.ok(channel.sent.includes('hello'))
  } finally {
    h.restore()
  }
})
