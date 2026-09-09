import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 25))

function installFakes() {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor(url) {
      this.url = url
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      sockets.push(this)
    }

    send(value) { this.sent.push(JSON.parse(value)) }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code }) }
  }

  class FakeDataChannel {
    constructor() { this.readyState = 'connecting' }
    send() {}
    close() { this.readyState = 'closed'; this.onclose?.() }
  }

  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      this.candidates = []
      peerConnections.push(this)
    }

    addTransceiver() {}
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:local\r\n' } }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:answer\r\n' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
    }
    async addIceCandidate(candidate) { this.candidates.push(candidate) }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
      this.onconnectionstatechange?.()
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  return {
    sockets,
    peerConnections,
    restore() {
      globalThis.WebSocket = originalWebSocket
      globalThis.RTCPeerConnection = originalRTCPeerConnection
    },
  }
}

const LOCAL = 'a'.repeat(64)
const REMOTE = 'b'.repeat(64)

function meshEnvelope(type, body, overrides = {}) {
  return {
    psp_version: '1.0',
    type,
    network: 'test-network',
    from: REMOTE,
    to: LOCAL,
    session_id: 'test-room',
    message_id: `mesh-${type}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    ttl_ms: 10000,
    reply_to: null,
    body,
    ...overrides,
  }
}

test('an offer to a mesh-reachable peer travels over the mesh, and its answer comes back the same way', async () => {
  const fakes = installFakes()
  const meshFrames = []
  const logs = []
  let client
  try {
    client = createSignalingClient({
      peerId: LOCAL,
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onLog: (message) => logs.push(message),
      signalTransport: (envelope) => {
        if (envelope.to !== REMOTE) return false
        meshFrames.push(envelope)
        return true
      },
    })

    // Not even registered on a relay yet: the mesh path does not need it.
    await client.initiateConnection(REMOTE)
    await nextTurn()

    const offers = meshFrames.filter((frame) => frame.type === 'offer')
    assert.equal(offers.length, 1, 'the offer went to the mesh transport')
    assert.equal(offers[0].from, LOCAL)
    assert.equal(offers[0].to, REMOTE)
    assert.equal(offers[0].session_id, 'test-room')
    assert.equal(offers[0].ttl_ms, 10000)
    assert.equal(fakes.sockets.length, 0, 'no relay socket was opened for it')
    assert.ok(logs.some((line) => line.includes(`sending offer to ${REMOTE} via mesh`)))

    const pc = fakes.peerConnections[0]
    assert.equal(pc.signalingState, 'have-local-offer')

    // The answer arrives through the mesh and is applied like a relayed one.
    assert.equal(client.injectSignal(meshEnvelope('answer', { sdp: 'v=0\r\na=ice-ufrag:answer\r\n' })), true)
    await nextTurn()
    assert.equal(pc.remoteDescription?.type, 'answer')
    assert.equal(pc.signalingState, 'stable')

    assert.equal(client.injectSignal(meshEnvelope('ice_candidate', { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host' } })), true)
    await nextTurn()
    assert.equal(pc.candidates.length, 1)
  } finally {
    client?.disconnect()
    fakes.restore()
  }
})

test('the relay carries a frame the mesh cannot route, so nothing is lost while the mesh is thin', async () => {
  const fakes = installFakes()
  let client
  try {
    client = createSignalingClient({
      peerId: LOCAL,
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      signalTransport: () => false,
    })
    client.connect()
    const socket = fakes.sockets[0]
    socket.open()
    socket.receive({ type: 'ack', body: { status: 'ok' } })

    await client.initiateConnection(REMOTE)
    await nextTurn()

    const offers = socket.sent.filter((frame) => frame.type === 'offer' && frame.to === REMOTE)
    assert.equal(offers.length, 1, 'the offer fell back to the relay socket')
  } finally {
    client?.disconnect()
    fakes.restore()
  }
})

test('a mesh-delivered frame is only accepted when it is genuinely for this peer', async () => {
  const fakes = installFakes()
  let client
  try {
    client = createSignalingClient({
      peerId: LOCAL,
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
    })
    const answer = { sdp: 'v=0\r\n' }
    assert.equal(client.injectSignal(meshEnvelope('answer', answer, { to: 'c'.repeat(64) })), false, 'addressed elsewhere')
    assert.equal(client.injectSignal(meshEnvelope('answer', answer, { from: LOCAL })), false, 'from ourselves')
    assert.equal(client.injectSignal(meshEnvelope('answer', answer, { session_id: 'other-room' })), false, 'another room')
    assert.equal(client.injectSignal(meshEnvelope('answer', answer, { network: 'other-network' })), false, 'another network')
    assert.equal(client.injectSignal(meshEnvelope('announce', {})), false, 'not a negotiation frame')
    assert.equal(client.injectSignal(null), false)
    assert.equal(fakes.peerConnections.length, 0)
  } finally {
    client?.disconnect()
    fakes.restore()
  }
})
