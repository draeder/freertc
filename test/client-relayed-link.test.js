import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

// Two clients on one fake relay. Frames addressed to a peer are handed to that
// peer's socket, as the relay does; WebRTC never connects (the pair that
// needs a relayed link).
function installWorld() {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const byPeer = new Map()
  const sockets = []

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
      const message = JSON.parse(value)
      this.sent.push(message)
      if (message.type === 'announce' || message.type === 'register') byPeer.set(message.from, this)
      if (message.from) byPeer.set(message.from, this)
      const target = message.to && byPeer.get(message.to)
      if (target && target !== this) setTimeout(() => target.onmessage?.({ data: JSON.stringify(message) }), 1)
    }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    close(code = 1000) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code }) }
  }

  class FakeDataChannel {
    constructor() { this.readyState = 'connecting' }
    send() {}
    close() { this.readyState = 'closed'; this.onclose?.() }
  }

  class NeverConnects {
    constructor() {
      this.signalingState = 'stable'
      this.connectionState = 'new'
      this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'
      this.localDescription = null
      this.remoteDescription = null
    }
    addTransceiver() {}
    createDataChannel() { return new FakeDataChannel() }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:x\r\n' } }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:y\r\n' } }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable' }
    async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
    async addIceCandidate() {}
    addEventListener() {}
    removeEventListener() {}
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; this.onconnectionstatechange?.() }
  }

  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = NeverConnects
  return {
    sockets,
    restore() {
      globalThis.WebSocket = originalWebSocket
      globalThis.RTCPeerConnection = originalRTCPeerConnection
    },
  }
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function client(peerId, signalUrl, received, states, extra = {}) {
  return createSignalingClient({
    peerId,
    networkId: 'test-network',
    roomId: 'test-room',
    signalUrl,
    autoConnect: false,
    onDataMessage: ({ peerId: from, data }) => received.push([from, data]),
    onConnectionStateChange: ({ peerId: who, state }) => states.push([who, state]),
    ...extra,
  })
}

async function register(world, c, peerId) {
  c.connect()
  const socket = world.sockets.at(-1)
  socket.open()
  socket.receive({ type: 'ack', body: { status: 'ok' } })
  // Let the fake relay learn which socket is this peer's.
  socket.send(JSON.stringify({ type: 'ping', from: peerId }))
  await nextTurn()
  return socket
}

test('a pair whose WebRTC never connects links through a local relay after two failures', async (t) => {
  const world = installWorld()
  const gotA = []; const gotB = []; const statesA = []; const statesB = []
  const a = client(A, 'ws://192.168.1.10:8788/ws', gotA, statesA)
  const b = client(B, 'ws://192.168.1.10:8788/ws', gotB, statesB)
  t.after(() => { a.disconnect(); b.disconnect(); world.restore() })
  await register(world, a, A)
  await register(world, b, B)

  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  t.after(() => { Date.now = realNow })

  // Two dials that never open, each given up on by the host.
  for (let i = 0; i < 2; i++) {
    await a.initiateConnection(B)
    await nextTurn()
    offset += 10_000
    a.closePeerConnection(B, 'stalled', false)
  }
  // The third goes through the relay.
  await a.initiateConnection(B)
  await nextTurn(50)

  const entryA = a.mesh.connections.get(B)
  const entryB = b.mesh.connections.get(A)
  assert.equal(entryA?.relayed, true, 'A holds a relayed link')
  assert.equal(entryB?.relayed, true, 'B accepted it')
  assert.equal(entryA.channel?.readyState, 'open')
  assert.equal(entryB.channel?.readyState, 'open')
  assert.ok(statesA.some(([who, s]) => who === B && s === 'connected'))
  assert.ok(statesB.some(([who, s]) => who === A && s === 'connected'))

  // The keepalive pings proved both directions, so app data flows.
  await nextTurn(50)
  a.sendData('hello from A', B)
  b.sendData('hello from B', A)
  await nextTurn(50)
  assert.deepEqual(gotB, [[A, 'hello from A']])
  assert.deepEqual(gotA, [[B, 'hello from B']])

  // Closing one end closes the other.
  a.closePeerConnection(B, 'done')
  await nextTurn(50)
  assert.equal(b.mesh.connections.get(A)?.channel?.readyState === 'open', false, 'B saw the link close')
})

test('on a cloud relay the pair keeps trying WebRTC (no per-message cost) unless told otherwise', async (t) => {
  const world = installWorld()
  const a = client(A, 'wss://peer.ooo/ws', [], [])
  t.after(() => { a.disconnect(); world.restore() })
  await register(world, a, A)
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  t.after(() => { Date.now = realNow })
  for (let i = 0; i < 3; i++) {
    await a.initiateConnection(B)
    await nextTurn()
    offset += 10_000
    a.closePeerConnection(B, 'stalled', false)
  }
  await a.initiateConnection(B)
  await nextTurn()
  assert.notEqual(a.mesh.connections.get(B)?.relayed, true)
})
