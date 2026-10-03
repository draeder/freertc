import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

// Relay on demand: a peer whose mesh is healthy releases its relay socket unless it is one of the
// room's anchors (the peers closest to the room key), and wakes it when it needs it again.

const NETWORK = 'test-network'
const ROOM = 'test-room'
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const keyOf = async (text) => BigInt(`0x${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))}`)
const randomId = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Peer ids sorted by how close they are to the room, closest first, so a test can say exactly who is
// an anchor: with three anchors, pool[0..2] are, and pool[10] is not.
async function poolByCloseness(size = 40) {
  const roomKey = await keyOf(`${NETWORK}:${ROOM}`)
  const scored = await Promise.all(Array.from({ length: size }, async () => {
    const id = randomId()
    return { id, distance: (await keyOf(id)) ^ roomKey }
  }))
  scored.sort((a, b) => (a.distance < b.distance ? -1 : 1))
  return scored.map((entry) => entry.id)
}

function harness(localPeerId, { relay = { mode: 'on-demand', settleMs: 0, evalMs: 3_600_000 }, signalTransport = () => false, onDataMessage } = {}) {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const peerConnections = []
  const relayStates = []
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    constructor() { this.readyState = FakeWebSocket.CONNECTING; this.sent = []; sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.closeCode = code; this.onclose?.({ code }) }
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
    peerId: localPeerId, networkId: NETWORK, roomId: ROOM, signalUrl: 'wss://signal.example/ws', autoConnect: false,
    relay, signalTransport, onDataMessage, onRelayStateChange: (event) => relayStates.push(event.state),
  })
  client.connect()
  const socket = sockets[0]
  socket.open()
  socket.receive({ type: 'ack', body: { status: 'ok' } })

  // A neighbour with a data channel that is open and has answered a ping: live. Its negotiation is
  // finished, as a real connected peer's is: the answer has been applied, so the offer is no longer
  // retried over the relay.
  async function addLiveNeighbour(id) {
    await client.initiateConnection(id)
    const pc = peerConnections.at(-1)
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\n' }
    pc.signalingState = 'stable'
    const channel = pc.channels[0]
    channel.open()
    channel.deliver({ type: 'pong', ts: Date.now() })
    const entry = client.mesh.connections.get(id)
    entry.state = 'connected'
    return { channel, entry }
  }
  const restore = () => {
    client.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
  return { client, socket, sockets, peerConnections, relayStates, addLiveNeighbour, restore }
}

test('by default the relay socket is never released, however healthy the mesh', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { relay: {} })
  try {
    for (const id of pool.slice(0, 4)) await h.addLiveNeighbour(id)
    assert.equal(h.client.relayMode, 'always')
    assert.equal(await h.client.evaluateRelay(), null)
    assert.equal(h.client.relayIdle, false)
    assert.equal(h.client.isRegistered, true)
    assert.equal(h.socket.readyState, 1)
  } finally { h.restore() }
})

test('on-demand needs a host that carries signaling over the mesh, and is otherwise ignored', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { signalTransport: null })
  try {
    for (const id of pool.slice(0, 4)) await h.addLiveNeighbour(id)
    assert.equal(h.client.relayMode, 'always')
    assert.equal(await h.client.evaluateRelay(), null)
    assert.equal(h.socket.readyState, 1)
  } finally { h.restore() }
})

test('a peer with too few live neighbours is isolated and keeps its relay', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    await h.addLiveNeighbour(pool[0])
    const decision = await h.client.evaluateRelay()
    assert.equal(decision.isolated, true)
    assert.equal(decision.wantRelay, true)
    assert.equal(h.client.relayIdle, false)
    assert.equal(h.socket.readyState, 1)
  } finally { h.restore() }
})

test('an anchor keeps its relay even when its mesh is healthy', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[0])
  try {
    for (const id of pool.slice(20, 24)) await h.addLiveNeighbour(id)
    const decision = await h.client.evaluateRelay()
    assert.equal(decision.isolated, false)
    assert.equal(decision.isAnchor, true)
    assert.equal(h.client.relayIdle, false)
    assert.equal(h.socket.readyState, 1)
  } finally { h.restore() }
})

test('a healthy peer that is not an anchor withdraws and releases the relay, and nothing reopens it', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    const decision = await h.client.evaluateRelay()
    assert.deepEqual(decision.anchors, pool.slice(0, 3), 'the three closest are the anchors')
    assert.equal(decision.isAnchor, false)

    assert.equal(h.client.relayIdle, true)
    assert.equal(h.client.isRegistered, false)
    assert.equal(h.socket.closeCode, 1000)
    const withdraw = h.socket.sent.find((m) => m.type === 'withdraw')
    assert.equal(withdraw?.body?.reason, 'relay_idle', 'the relay is told this peer is leaving, so it stops listing it')
    assert.deepEqual(h.relayStates, ['up', 'idle'])

    await pause(150)
    assert.equal(h.sockets.length, 1, 'a deliberate release must not be retried like a drop')
  } finally { h.restore() }
})

test('the relay is released only once the peer has been releasable for the settle time', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { relay: { mode: 'on-demand', settleMs: 200, evalMs: 3_600_000 } })
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, false, 'a first look is not enough')
    await pause(250)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)
  } finally { h.restore() }
})

test('a negotiation still in flight keeps the relay, since its answer may only come by relay', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.initiateConnection(randomId()) // dialed, not yet connected
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, false)
  } finally { h.restore() }
})

test('losing neighbours wakes a released relay', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    const neighbours = []
    for (const id of pool.slice(0, 3)) neighbours.push({ id, ...(await h.addLiveNeighbour(id)) })
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)

    // The mesh falls apart: two of the three channels die.
    neighbours[0].channel.close()
    neighbours[1].channel.close()
    const decision = await h.client.evaluateRelay()
    assert.equal(decision.isolated, true)
    assert.equal(h.client.relayIdle, false)
    assert.equal(h.sockets.length, 2, 'a fresh relay socket was opened')
    assert.ok(h.relayStates.includes('waking'))
  } finally { h.restore() }
})

test('a signaling frame the mesh cannot carry wakes the released relay', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)

    h.client.relay(randomId(), 'offer', { sdp: 'v=0\r\n' })
    assert.equal(h.client.relayIdle, false)
    assert.equal(h.sockets.length, 2)
  } finally { h.restore() }
})

test('a frame the mesh did carry does not wake the relay', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { signalTransport: () => true })
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)

    h.client.relay(pool[1], 'offer', { sdp: 'v=0\r\n' })
    assert.equal(h.client.relayIdle, true)
    assert.equal(h.sockets.length, 1)
  } finally { h.restore() }
})

test('a discovery asked for while the relay is released goes out once it has registered again', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)

    h.client.requestBootstrap()
    assert.equal(h.sockets.length, 2)
    const reopened = h.sockets[1]
    reopened.open()
    assert.equal(reopened.sent.some((m) => m.type === 'discover'), false, 'not before it is registered')
    reopened.receive({ type: 'ack', body: { status: 'ok' } })
    assert.equal(reopened.sent.some((m) => m.type === 'discover'), true)
  } finally { h.restore() }
})

test('an explicit wake keeps the relay for the linger time, then lets it go again', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { relay: { mode: 'on-demand', settleMs: 0, lingerMs: 150, evalMs: 3_600_000 } })
  try {
    for (const id of pool.slice(0, 3)) await h.addLiveNeighbour(id)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true)

    h.client.wakeRelay('test')
    h.sockets[1].open()
    h.sockets[1].receive({ type: 'ack', body: { status: 'ok' } })
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, false, 'held up while the linger time runs')
    await pause(200)
    await h.client.evaluateRelay()
    assert.equal(h.client.relayIdle, true, 'let go once it is over')
  } finally { h.restore() }
})

test('neighbours telling a peer that closer peers exist is what lets it release the relay', async () => {
  const pool = await poolByCloseness()
  const forwarded = []
  const h = harness(pool[10], { onDataMessage: (message) => forwarded.push(message) })
  try {
    // Two neighbours, both farther from the room than this peer, so alone it would be an anchor.
    const far = []
    for (const id of pool.slice(20, 22)) far.push(await h.addLiveNeighbour(id))
    const before = await h.client.evaluateRelay()
    assert.equal(before.isAnchor, true)
    assert.equal(h.client.relayIdle, false)

    // One of them says it can vouch for the three closest peers, who are not connected to this one.
    far[0].channel.deliver({ type: '~anchors', ids: pool.slice(0, 3) })
    assert.deepEqual(far[0].entry.anchorGossip.ids, pool.slice(0, 3))
    assert.deepEqual(forwarded, [], 'control traffic is never handed to the host as data')

    const after = await h.client.evaluateRelay()
    assert.deepEqual(after.anchors, pool.slice(0, 3))
    assert.equal(after.isAnchor, false)
    assert.equal(h.client.relayIdle, true)
  } finally { h.restore() }
})

test('a neighbour that stops vouching is forgotten, so an anchor that vanished is replaced', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { relay: { mode: 'on-demand', settleMs: 0, gossipTtlMs: 120, evalMs: 3_600_000 } })
  try {
    const far = []
    for (const id of pool.slice(20, 22)) far.push(await h.addLiveNeighbour(id))
    far[0].channel.deliver({ type: '~anchors', ids: pool.slice(0, 3) })
    assert.equal((await h.client.evaluateRelay()).isAnchor, false)
    assert.equal(h.client.relayIdle, true)

    await pause(160) // the word has gone stale and nobody repeated it
    const decision = await h.client.evaluateRelay()
    assert.equal(decision.isAnchor, true, 'this peer is now among the closest it can vouch for')
    assert.equal(h.client.relayIdle, false, 'so it is back on the relay')
  } finally { h.restore() }
})

test('a peer tells its live neighbours which peers it can vouch for', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10])
  try {
    const neighbours = []
    for (const id of pool.slice(0, 3)) neighbours.push(await h.addLiveNeighbour(id))
    const decision = await h.client.evaluateRelay()
    for (const { channel } of neighbours) {
      const frame = channel.sent.find((m) => m.type === '~anchors')
      assert.deepEqual(frame?.ids, decision.direct)
    }
  } finally { h.restore() }
})

test('the anchor count and minimum mesh size cannot be configured to zero', async () => {
  const pool = await poolByCloseness()
  const h = harness(pool[10], { relay: { mode: 'on-demand', anchors: 0, minMeshPeers: 0, settleMs: 0, evalMs: 3_600_000 } })
  try {
    const decision = await h.client.evaluateRelay()
    assert.equal(decision.anchors.length, 1, 'at least one anchor, so a room is never without a way in')
    assert.equal(decision.isolated, true, 'and a peer with no neighbours is still isolated')
  } finally { h.restore() }
})
