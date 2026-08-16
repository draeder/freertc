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

test('an isolated peer queues an answer until its local offer is ready', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      sockets.push(this)
    }
    send(value) { this.sent.push(JSON.parse(value)) }
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
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description
      this.signalingState = 'stable'
    }
    async addIceCandidate() {}
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onLog: (message) => logs.push(message),
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })
    await client.initiateConnection('isolated-peer')

    const pc = peerConnections[0]
    pc.signalingState = 'stable'
    sockets[0].receive({
      type: 'answer',
      from: 'isolated-peer',
      session_id: 'test-room',
      body: { sdp: 'answer:isolated-peer' },
    })
    await nextTurn()

    assert.ok(logs.some((line) => line.includes('queued answer from isolated-peer') && line.includes('peer isolated')))
    assert.ok(logs.every((line) => !line.includes('ignoring answer from isolated-peer')))
    assert.equal(pc.remoteDescription, null)

    pc.signalingState = 'have-local-offer'
    pc.onsignalingstatechange?.()
    await nextTurn()

    assert.equal(pc.remoteDescription?.type, 'answer')
    assert.equal(pc.remoteDescription?.sdp, 'answer:isolated-peer')
    assert.ok(logs.some((line) => line.includes('applied answer from isolated-peer')))
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
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

test('recovery reset clears offer backoff and retransmits immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
    send(value) { this.sent.push(JSON.parse(value)) }
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

  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
    }
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
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

    const offers = () => sockets[0].sent.filter((message) => message.type === 'offer').length
    assert.equal(offers(), 1)
    t.mock.timers.tick(100)
    t.mock.timers.tick(250)
    assert.equal(offers(), 3)

    const entry = client.mesh.connections.get('remote-peer')
    entry.lastAnswerBurstAt = 123
    entry.lastAnswerSentAt = 456
    client.resetRecoveryBackoffs()
    assert.equal(offers(), 4)
    assert.equal(entry.lastAnswerBurstAt, 0)
    assert.equal(entry.lastAnswerSentAt, 0)

    // The retry sequence starts at its shortest delay again after resume.
    t.mock.timers.tick(100)
    assert.equal(offers(), 5)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})

test('an unreachable offer fails over in under three seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const failures = []

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      sockets.push(this)
    }
    send(value) { this.sent.push(JSON.parse(value)) }
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

  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
    }
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onNegotiationFailure: (details) => failures.push(details),
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })
    await client.initiateConnection('unreachable-peer')

    const offers = () => sockets[0].sent.filter((message) => message.type === 'offer').length
    assert.equal(offers(), 1)
    t.mock.timers.tick(100)
    t.mock.timers.tick(250)
    t.mock.timers.tick(500)
    t.mock.timers.tick(1_000)
    t.mock.timers.tick(999)
    assert.equal(failures.length, 0)
    assert.equal(offers(), 5)
    t.mock.timers.tick(1)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].peerId, 'unreachable-peer')
    assert.equal(failures[0].reason, 'offer_retries_exhausted')
    assert.equal(client.mesh.connections.get('unreachable-peer')?.state, 'dead')
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

test('700-level ICE candidate diagnostics never alter current or future ICE configuration', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []
  let transceiverCalls = 0

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

  class IceRTCPeerConnection {
    constructor(configuration) {
      this.configuration = structuredClone(configuration)
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      peerConnections.push(this)
    }
    addTransceiver() { transceiverCalls += 1 }
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: `offer:${peerConnections.indexOf(this)}` } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'have-local-offer'
    }
    getConfiguration() { return structuredClone(this.configuration) }
    setConfiguration(configuration) { this.configuration = structuredClone(configuration) }
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = IceRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      iceServers: [{ urls: ['stun:failed.example:3478', 'stun:healthy.example:3478'] }],
      autoConnect: false,
      onLog: (message) => logs.push(message),
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })

    await client.initiateConnection('remote-a')
    peerConnections[0].onicecandidateerror({
      errorCode: 701,
      errorText: 'server unreachable',
      url: 'stun:failed.example:3478',
    })
    peerConnections[0].onicecandidateerror({
      errorCode: 701,
      errorText: 'server unreachable',
      url: 'stun:failed.example:3478',
    })
    peerConnections[0].onicecandidateerror({
      errorCode: 799,
      errorText: 'browser-specific candidate diagnostic',
      url: 'stun:healthy.example:3478',
    })
    await client.initiateConnection('remote-b')

    assert.equal(transceiverCalls, 0)
    assert.deepEqual(peerConnections[0].configuration.iceServers, [
      { urls: ['stun:failed.example:3478', 'stun:healthy.example:3478'] },
    ])
    assert.deepEqual(peerConnections[1].configuration.iceServers, [
      { urls: ['stun:failed.example:3478', 'stun:healthy.example:3478'] },
    ])
    assert.equal(logs.filter((line) => line.includes('non-fatal ICE candidate diagnostic')).length, 3)
    assert.equal(logs.some((line) => line.includes('quarantined')), false)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})

test('RTP extension remaps retry on a fresh data-only connection', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const logs = []
  let injectRemapError = true

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING
      this.sent = []
      sockets.push(this)
    }
    send(value) { this.sent.push(JSON.parse(value)) }
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

  class RemapRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
      peerConnections.push(this)
    }
    createDataChannel() { return new FakeDataChannel() }
    async setRemoteDescription(description) {
      if (injectRemapError) {
        injectRemapError = false
        const error = new Error('Remote description attempted to remap RTP extension id 3')
        error.name = 'InvalidAccessError'
        throw error
      }
      this.remoteDescription = description
      this.signalingState = 'have-remote-offer'
    }
    async createAnswer() { return { type: 'answer', sdp: `answer:${peerConnections.indexOf(this)}` } }
    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = 'stable'
    }
    async addIceCandidate() {}
    close() {
      this.signalingState = 'closed'
      this.connectionState = 'closed'
    }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = RemapRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer',
      networkId: 'test-network',
      roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
      onLog: (message) => logs.push(message),
    })
    client.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'ack', body: { status: 'ok' } })

    sockets[0].receive({
      type: 'offer',
      from: 'remote-peer',
      session_id: 'test-room',
      body: { sdp: 'offer:first' },
    })
    await nextTurn()

    assert.equal(peerConnections.length, 2)
    assert.equal(peerConnections[0].signalingState, 'closed')
    assert.equal(peerConnections[1].remoteDescription?.sdp, 'offer:first')
    assert.ok(logs.some((line) => line.includes('fresh connection after RTP extension remap')))
    assert.ok(logs.every((line) => !line.includes('handleIncomingOffer failed')))

    sockets[0].receive({
      type: 'offer',
      from: 'remote-peer',
      session_id: 'test-room',
      body: { sdp: 'offer:replacement' },
    })
    await nextTurn()

    assert.equal(peerConnections.length, 3)
    assert.equal(peerConnections[1].signalingState, 'closed')
    assert.equal(peerConnections[2].remoteDescription?.sdp, 'offer:replacement')
    assert.ok(logs.some((line) => line.includes('replaced stale connection for new offer')))
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})
