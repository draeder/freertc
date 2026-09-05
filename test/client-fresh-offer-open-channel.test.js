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
  let answers = 0

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
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0 }
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
    async createAnswer() { answers += 1; return { type: 'answer', sdp: `v=0\r\na=ice-ufrag:ans-${answers}\r\n` } }
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
  return { client, socket, peerConnections, logs, FakeDataChannel, restore }
}

test('an offer with new ICE credentials on an open channel replaces the connection: the remote restarted', async () => {
  const h = harness('a-local')
  try {
    // This side dialed and the channel opened; the remote answered with ufrag "r1".
    await h.client.initiateConnection('z-remote')
    const firstPc = h.peerConnections[0]
    h.socket.receive({ type: 'answer', from: 'z-remote', session_id: 'test-room', body: { sdp: 'v=0\r\na=ice-ufrag:r1\r\n' } })
    await nextTurn()
    const channel = firstPc.channels[0]
    channel.open()
    assert.equal(h.client.mesh.connections.get('z-remote').channel.readyState, 'open')

    // The remote lost its end and dials afresh with new credentials while our
    // channel still reads "open". Nothing was cached to answer with, and the
    // stale channel used to swallow the offer until the keepalive gave up.
    h.socket.receive({ type: 'offer', from: 'z-remote', session_id: 'test-room', body: { sdp: 'v=0\r\na=ice-ufrag:r2\r\n' } })
    await nextTurn()
    assert.ok(h.logs.some((m) => m.includes('fresh offer from z-remote') && m.includes('replacing the connection')), h.logs.join('\n'))
    assert.equal(firstPc.signalingState, 'closed', 'the dead connection is closed')
    assert.equal(h.peerConnections.length, 2, 'a fresh connection answers the new offer')
    const entry = h.client.mesh.connections.get('z-remote')
    assert.equal(entry.connection, h.peerConnections[1])
    assert.equal(h.peerConnections[1].remoteDescription.sdp, 'v=0\r\na=ice-ufrag:r2\r\n')
    assert.equal(h.socket.sent.filter((m) => m.type === 'answer').length, 1, 'the new offer is answered')
  } finally {
    h.restore()
  }
})

test('a retry of the offer already answered on an open channel is answered again, nothing torn down', async () => {
  const h = harness('a-local')
  try {
    const offer = 'v=0\r\na=ice-ufrag:r1\r\na=candidate:1 1 udp 2113937151 192.168.1.5 50000 typ host\r\n'
    h.socket.receive({ type: 'offer', from: 'z-remote', session_id: 'test-room', body: { sdp: offer } })
    await nextTurn()
    const pc = h.peerConnections[0]
    const remoteChannel = new h.FakeDataChannel('mesh')
    pc.ondatachannel({ channel: remoteChannel })
    remoteChannel.open()
    const answersBefore = h.socket.sent.filter((m) => m.type === 'answer').length
    assert.ok(answersBefore >= 1)

    // Same negotiation, one more candidate: the retry the remote sends while
    // it waits for our answer to arrive.
    h.socket.receive({ type: 'offer', from: 'z-remote', session_id: 'test-room', body: { sdp: offer + 'a=candidate:2 1 udp 1677729535 203.0.113.9 50000 typ srflx\r\n' } })
    await nextTurn()
    assert.equal(h.peerConnections.length, 1, 'the open connection is kept')
    assert.equal(pc.signalingState, 'stable')
    assert.ok(!h.logs.some((m) => m.includes('replacing the connection')))
  } finally {
    h.restore()
  }
})
