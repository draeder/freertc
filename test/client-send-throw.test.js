import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

test('a channel that throws from send() while reporting open refuses the frame as transient', () => {
  const originalWebSocket = globalThis.WebSocket
  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    constructor() { this.readyState = FakeWebSocket.CONNECTING }
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket
  let client
  try {
    client = createSignalingClient({
      peerId: 'a'.repeat(64),
      networkId: 'n',
      roomId: 'r',
      signalUrl: 'wss://signal.example/ws',
      autoConnect: false,
    })
    const now = Date.now()
    client.mesh.connections.set('b'.repeat(64), {
      connection: { connectionState: 'connected', signalingState: 'stable' },
      channel: { readyState: 'open', bufferedAmount: 0, send() { throw new Error('Error sending string through RTCDataChannel.') } },
      state: 'connected',
      lastPongAt: now,
      lastPingSentAt: 0,
    })
    let caught = null
    try {
      client.sendData('hello', 'b'.repeat(64))
    } catch (error) {
      caught = error
    }
    assert.ok(caught, 'the refusal is surfaced')
    assert.equal(caught.transient, true, 'but it is transient: the pong proof decides whether the edge is dead')
    assert.match(caught.message, /refused a frame/)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
  }
})
