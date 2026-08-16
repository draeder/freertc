import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 25))

async function runGlareScenario(localPeerId, remotePeerId) {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []
  let activeRemoteDescriptionCalls = 0
  let maxConcurrentRemoteDescriptionCalls = 0
  let markOfferCreationStarted
  let releaseOfferCreation
  const offerCreationStarted = new Promise((resolve) => { markOfferCreationStarted = resolve })
  const offerCreationGate = new Promise((resolve) => { releaseOfferCreation = resolve })

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

    send(value) {
      this.sent.push(JSON.parse(value))
    }

    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) })
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code })
    }
  }

  class FakeDataChannel {
    constructor() {
      this.readyState = 'connecting'
    }

    send() {}

    close() {
      this.readyState = 'closed'
      this.onclose?.()
    }
  }

  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      peerConnections.push(this)
    }

    addTransceiver() {}

    createDataChannel() {
      return new FakeDataChannel()
    }

    async createOffer() {
      // Keep the local offer operation open long enough for a remote offer to
      // arrive. This reproduces the real glare race that occurs when both peers
      // dial immediately after the same discovery snapshot.
      markOfferCreationStarted()
      await offerCreationGate
      return { type: 'offer', sdp: `offer:${localPeerId}` }
    }

    async createAnswer() {
      return { type: 'answer', sdp: `answer:${localPeerId}` }
    }

    async setLocalDescription(description) {
      if (description.type === 'rollback') {
        this.localDescription = null
        this.signalingState = 'stable'
        return
      }
      this.localDescription = description
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    }

    async setRemoteDescription(description) {
      activeRemoteDescriptionCalls += 1
      maxConcurrentRemoteDescriptionCalls = Math.max(
        maxConcurrentRemoteDescriptionCalls,
        activeRemoteDescriptionCalls,
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
      this.remoteDescription = description
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
      activeRemoteDescriptionCalls -= 1
    }

    async addIceCandidate() {}

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

  let client
  try {
    client = createSignalingClient({
      peerId: localPeerId,
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onLog: (message) => logs.push(message),
    })

    client.connect()
    const socket = sockets[0]
    socket.open()
    socket.receive({ type: 'ack', body: { status: 'ok' } })

    const initiation = client.initiateConnection(remotePeerId)
    await offerCreationStarted
    const pc = peerConnections[0]

    // A resumed tab can receive this burst in one event-loop turn. Previously
    // local offer creation and the answer path both bypassed the offer queue,
    // so these calls could mutate the same RTCPeerConnection concurrently.
    socket.receive({
      type: 'offer',
      from: remotePeerId,
      session_id: 'test-room',
      body: { sdp: `offer:${remotePeerId}` },
    })
    socket.receive({
      type: 'answer',
      from: remotePeerId,
      session_id: 'test-room',
      body: { sdp: `answer:${remotePeerId}` },
    })

    releaseOfferCreation()
    await initiation
    await nextTurn()
    return { logs, maxConcurrentRemoteDescriptionCalls, pc }
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
}

test('offer/answer bursts are serialized and simultaneous offers have one winner', async () => {
  const impolite = await runGlareScenario('a-local', 'z-remote')
  assert.equal(impolite.maxConcurrentRemoteDescriptionCalls, 1)
  assert.equal(impolite.pc.remoteDescription?.type, 'answer')
  assert.ok(impolite.logs.some((line) => line.includes('ignoring colliding offer')))
  assert.ok(impolite.logs.every((line) => !line.includes('apply in flight')))

  const polite = await runGlareScenario('z-local', 'a-remote')
  assert.equal(polite.maxConcurrentRemoteDescriptionCalls, 1)
  assert.equal(polite.pc.remoteDescription?.type, 'offer')
  assert.ok(polite.logs.some((line) => line.includes('rolled back local offer')))
  assert.ok(polite.logs.every((line) => !line.includes('apply in flight')))
})

test('trickle ICE sends the initial offer without waiting for candidate gathering', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      sockets.push(this)
    }

    send(value) {
      this.sent.push(JSON.parse(value))
    }

    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) })
    }

    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code })
    }
  }

  class FakeDataChannel {
    constructor() {
      this.readyState = 'connecting'
    }

    send() {}
    close() { this.readyState = 'closed' }
  }

  class GatheringRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      // Deliberately never becomes complete. A non-trickle implementation
      // would hold the offer for its four-second gathering timeout.
      this.iceGatheringState = 'gathering'
      this.localDescription = null
      this.remoteDescription = null
    }

    addTransceiver() {}
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
      this.onconnectionstatechange?.()
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = GatheringRTCPeerConnection

  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
    })
    client.connect()
    const socket = sockets[0]
    socket.open()
    socket.receive({ type: 'ack', body: { status: 'ok' } })

    const result = await Promise.race([
      client.initiateConnection('remote-peer').then(() => 'sent'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ])

    assert.equal(result, 'sent')
    const offer = socket.sent.find((message) => message.type === 'offer')
    assert.equal(offer?.body?.sdp, 'offer:local')
    assert.equal(offer?.body?.trickle_ice, true)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})

test('a silent data channel is closed after one unanswered ping deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const originalDateNow = Date.now
  const sockets = []
  const peerConnections = []
  let now = 0

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      sockets.push(this)
    }

    send() {}
    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code })
    }
  }

  class SilentDataChannel {
    constructor() {
      this.readyState = 'connecting'
      this.sent = []
    }

    send(value) { this.sent.push(JSON.parse(value)) }
    close() {
      if (this.readyState === 'closed') return
      this.readyState = 'closed'
      this.onclose?.()
    }
  }

  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      this.channel = new SilentDataChannel()
      peerConnections.push(this)
    }

    addTransceiver() {}
    createDataChannel() { return this.channel }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    close() {
      if (this.connectionState === 'closed') return
      this.signalingState = 'closed'
      this.connectionState = 'closed'
      this.onconnectionstatechange?.()
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  Date.now = () => now
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })
    await client.initiateConnection('remote-peer')

    const channel = peerConnections[0].channel
    channel.readyState = 'open'
    channel.onopen()

    now = 1_000
    t.mock.timers.tick(1_000)
    assert.equal(channel.sent.filter((message) => message.type === 'ping').length, 1)
    now = 4_999
    t.mock.timers.tick(3_999)
    assert.equal(channel.readyState, 'open')
    now = 5_000
    t.mock.timers.tick(1)
    assert.equal(channel.readyState, 'closed')
    assert.equal(peerConnections[0].connectionState, 'closed')
  } finally {
    client?.disconnect()
    Date.now = originalDateNow
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})

test('late events from a replaced transport cannot close its replacement', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const states = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      sockets.push(this)
    }
    send() {}
    open() {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code })
    }
  }

  class FakeDataChannel {
    constructor() { this.readyState = 'connecting' }
    send() {}
    close() { this.readyState = 'closed' }
  }

  class ReplaceableRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      this.channel = new FakeDataChannel()
      peerConnections.push(this)
    }
    addTransceiver() {}
    createDataChannel() { return this.channel }
    async createOffer() { return { type: 'offer', sdp: `offer:${peerConnections.indexOf(this)}` } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
      // Deliberately defer the browser's state event. It will arrive after the
      // next RTCPeerConnection has replaced this one in the mesh map.
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = ReplaceableRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onConnectionStateChange: (event) => states.push(event),
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })

    await client.initiateConnection('remote-peer')
    const first = peerConnections[0]
    await client.initiateConnection('remote-peer')
    const replacement = peerConnections[1]
    assert.equal(client.mesh.connections.get('remote-peer').connection, replacement)

    first.onconnectionstatechange()
    first.channel.onclose()

    const current = client.mesh.connections.get('remote-peer')
    assert.equal(current.connection, replacement)
    assert.equal(current.state, 'connecting')
    assert.equal(states.filter((event) => event.state === 'closed').length, 0)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})
