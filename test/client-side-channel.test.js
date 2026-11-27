import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 30))

// Side channels: more channels on a link's WebRTC connection, for the host's own traffic. They never
// stand in for the mesh channel, and a host that takes none refuses them.
function harness(localPeerId, onSideChannel) {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []
  const states = []

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
    constructor(label) { this.label = label; this.readyState = 'connecting' }
    send() {}
    open() { this.readyState = 'open'; this.onopen?.() }
    close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.() }
  }
  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'; this.localDescription = null; this.remoteDescription = null
      this.channels = []
      peerConnections.push(this)
    }
    addTransceiver() {}
    createDataChannel(label, init) { const channel = new FakeDataChannel(label); channel.init = init; this.channels.push(channel); return channel }
    async createOffer() { return { type: 'offer', sdp: `v=0\r\na=ice-ufrag:${localPeerId}\r\n` } }
    async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=ice-ufrag:ans-${localPeerId}\r\n` } }
    async setLocalDescription(d) {
      if (d.type === 'rollback') { this.localDescription = null; this.signalingState = 'stable'; return }
      this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
    }
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
    signalUrl: 'wss://signal.example/ws', autoConnect: false,
    onLog: (m) => logs.push(m),
    onConnectionStateChange: (event) => states.push(event.state),
    onSideChannel,
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
  return { client, socket, peerConnections, logs, states, FakeDataChannel, restore }
}

test('a side channel from the peer goes to the host, not in place of the mesh channel', async () => {
  const got = []
  const h = harness('a-local', (event) => got.push(event))
  try {
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    const mesh = pc.channels[0]
    const side = new h.FakeDataChannel('side:media')
    pc.ondatachannel({ channel: side })
    assert.equal(h.client.mesh.connections.get('z-remote').channel, mesh, 'the mesh channel stays')
    assert.equal(side.readyState, 'connecting', 'not closed as a duplicate')
    assert.equal(got.length, 1)
    assert.equal(got[0].peerId, 'z-remote')
    assert.equal(got[0].name, 'media')
    assert.equal(got[0].channel, side)
    assert.equal(side.binaryType, 'arraybuffer')
    assert.ok(!h.states.includes('closed'))
  } finally {
    h.restore()
  }
})

test('a host that takes no side channels refuses them', async () => {
  const h = harness('a-local')
  try {
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    const side = new h.FakeDataChannel('side:media')
    pc.ondatachannel({ channel: side })
    assert.equal(side.readyState, 'closed')
    assert.equal(h.client.mesh.connections.get('z-remote').channel, pc.channels[0])
  } finally {
    h.restore()
  }
})

test('a side channel opens on an open link, unordered with no retransmits, and not on one still opening', async () => {
  const h = harness('a-local')
  try {
    assert.equal(h.client.openSideChannel('z-remote', 'media'), null, 'no link')
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    assert.equal(h.client.openSideChannel('z-remote', 'media'), null, 'the mesh channel is not open yet')
    pc.channels[0].open()
    const side = h.client.openSideChannel('z-remote', 'media')
    assert.equal(side.label, 'side:media')
    assert.deepEqual(side.init, { ordered: false, maxRetransmits: 0 })
    assert.equal(side.binaryType, 'arraybuffer')
    assert.equal(h.client.mesh.connections.get('z-remote').channel, pc.channels[0])
  } finally {
    h.restore()
  }
})
