import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 30))

// Glare leaves both peers holding two data channels on one connection: the
// channel each created for its own offer, and the one the other created.
// Both peers must keep the SAME channel — the impolite peer's — or each
// closes the channel the other is using and the transport dies.
function harness(localPeerId) {
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
    createDataChannel(label) { const channel = new FakeDataChannel(label); this.channels.push(channel); return channel }
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

test('the polite peer withdraws the channel of its rolled-back offer and keeps the remote one', async () => {
  const h = harness('z-local')
  try {
    await h.client.initiateConnection('a-remote')
    const pc = h.peerConnections[0]
    const ownChannel = pc.channels[0]
    assert.equal(ownChannel.readyState, 'connecting')
    assert.equal(h.client.mesh.connections.get('a-remote').channel, ownChannel)

    h.socket.receive({ type: 'offer', from: 'a-remote', session_id: 'test-room', body: { sdp: 'v=0\r\na=ice-ufrag:a-remote\r\n' } })
    await nextTurn()
    assert.ok(h.logs.some((m) => m.includes('rolled back local offer for a-remote')))
    assert.equal(ownChannel.readyState, 'closed', 'the channel goes with the offer it was created for')
    assert.equal(h.client.mesh.connections.get('a-remote').channel, null)
    assert.ok(!h.states.includes('closed'), 'withdrawing the loser is not a transport event')

    // The winner's channel arrives over SCTP and is the one this peer keeps.
    const remoteChannel = new h.FakeDataChannel('mesh')
    pc.ondatachannel({ channel: remoteChannel })
    assert.equal(h.client.mesh.connections.get('a-remote').channel, remoteChannel)
    remoteChannel.open()
    assert.equal(remoteChannel.readyState, 'open')
    assert.ok(h.logs.some((m) => m.includes('data channel open to a-remote')))
    assert.ok(!h.states.includes('closed'))
  } finally {
    h.restore()
  }
})

test('the impolite peer keeps its own channel and closes the duplicate the polite peer opened', async () => {
  const h = harness('a-local')
  try {
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    const ownChannel = pc.channels[0]

    // The polite peer (an older build, or a channel SCTP opened before the
    // withdrawal landed) opened its channel on this connection too.
    const duplicate = new h.FakeDataChannel('mesh')
    pc.ondatachannel({ channel: duplicate })
    assert.equal(duplicate.readyState, 'closed', 'the duplicate is closed')
    assert.equal(h.client.mesh.connections.get('z-remote').channel, ownChannel, 'the local channel stays')
    assert.ok(h.logs.some((m) => m.includes('duplicate data channel from z-remote closed')))

    ownChannel.open()
    assert.ok(h.logs.some((m) => m.includes('data channel open to z-remote')))
    assert.ok(!h.states.includes('closed'), 'closing the duplicate is not a transport event')
    assert.equal(h.client.mesh.connections.get('z-remote').channel, ownChannel)
  } finally {
    h.restore()
  }
})

test('the polite peer that already holds the remote channel before its own arrives keeps the remote one', async () => {
  const h = harness('z-local')
  try {
    await h.client.initiateConnection('a-remote')
    const pc = h.peerConnections[0]
    const remoteChannel = new h.FakeDataChannel('mesh')
    pc.ondatachannel({ channel: remoteChannel })
    assert.equal(h.client.mesh.connections.get('a-remote').channel, remoteChannel)
    assert.equal(pc.channels[0].readyState, 'closed', 'the local channel is withdrawn for the remote one')
    assert.ok(h.logs.some((m) => m.includes('withdrawn for the remote one')))
  } finally {
    h.restore()
  }
})

test('negotiation frames carry a ten-second ttl so the relay never replays a dead offer', async () => {
  const h = harness('a-local')
  try {
    await h.client.initiateConnection('z-remote')
    const pc = h.peerConnections[0]
    pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } })
    pc.onicecandidate?.({ candidate: null })
    const byType = (type) => h.socket.sent.filter((m) => m.type === type)
    assert.ok(byType('offer').length >= 1)
    for (const type of ['offer', 'ice_candidate', 'ice_end']) {
      assert.ok(byType(type).length >= 1, `${type} was sent`)
      assert.ok(byType(type).every((m) => m.ttl_ms === 10000), `${type} is perishable`)
    }
    const registration = h.socket.sent.find((m) => !['offer', 'answer', 'ice_candidate', 'ice_end', 'renegotiate'].includes(m.type))
    assert.ok(registration, 'a non-negotiation frame was sent')
    assert.notEqual(registration.ttl_ms, 10000, 'only negotiation frames are perishable')
  } finally {
    h.restore()
  }
})
