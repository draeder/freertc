import assert from 'node:assert/strict'
import test from 'node:test'

import { createSignalingClient } from 'freertc/client'

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 30))

test('a retried offer with the same ICE ufrag is the same negotiation: answered again, never renegotiated', async () => {
  const originalWebSocket = globalThis.WebSocket
  const originalRTCPeerConnection = globalThis.RTCPeerConnection
  const sockets = []
  const logs = []
  let remoteDescriptions = 0
  let answersCreated = 0
  const addedCandidates = []

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
  class FakeRTCPeerConnection {
    constructor() {
      this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'
      this.iceGatheringState = 'complete'; this.localDescription = null; this.remoteDescription = null
    }
    addTransceiver() {}
    createDataChannel() { return { readyState: 'connecting', send() {}, close() {} } }
    async createOffer() { return { type: 'offer', sdp: 'offer:local' } }
    async createAnswer() { answersCreated += 1; return { type: 'answer', sdp: `v=0\r\na=ice-ufrag:ans${answersCreated}\r\n` } }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable' }
    async setRemoteDescription(d) { remoteDescriptions += 1; this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
    async addIceCandidate(c) { addedCandidates.push(c?.candidate ?? c) }
    addEventListener() {}
    removeEventListener() {}
    close() { this.signalingState = 'closed'; this.connectionState = 'closed' }
  }
  globalThis.WebSocket = FakeWebSocket
  globalThis.RTCPeerConnection = FakeRTCPeerConnection
  let client
  try {
    client = createSignalingClient({
      peerId: 'local-peer', networkId: 'test-network', roomId: 'test-room',
      signalUrl: 'wss://signal.example/ws', autoConnect: false, onLog: (m) => logs.push(m),
    })
    client.connect()
    const socket = sockets[0]
    socket.open()
    socket.receive({ type: 'ack', body: { status: 'ok' } })

    const first = 'v=0\r\na=ice-ufrag:abcd\r\na=ice-pwd:secret\r\na=candidate:1 1 udp 2113937151 192.168.1.5 50000 typ host\r\n'
    socket.receive({ type: 'offer', from: 'remote-peer', session_id: 'test-room', body: { sdp: first } })
    await nextTurn()
    assert.equal(remoteDescriptions, 1)
    assert.equal(answersCreated, 1)
    const answersSent = () => socket.sent.filter((m) => m.type === 'answer').length
    assert.equal(answersSent(), 1)

    // The retry: same negotiation (same ufrag), one more candidate gathered
    // since the first send. It used to be "applied as a renewed offer" and
    // re-answered with fresh credentials.
    const retried = first + 'a=candidate:2 1 udp 1677729535 203.0.113.9 50000 typ srflx raddr 192.168.1.5 rport 50000\r\n'
    socket.receive({ type: 'offer', from: 'remote-peer', session_id: 'test-room', body: { sdp: retried } })
    await nextTurn()
    assert.equal(remoteDescriptions, 1, 'no renegotiation for a retried offer')
    assert.equal(answersCreated, 1, 'the answer already given stands')
    assert.ok(addedCandidates.some((c) => String(c).includes('203.0.113.9')), 'the new candidate is taken')
    assert.ok(logs.some((m) => /retried offer from remote-peer \(same ufrag\)/.test(m)))

    // A genuinely new negotiation (new ufrag) still renegotiates.
    const fresh = 'v=0\r\na=ice-ufrag:wxyz\r\na=ice-pwd:other\r\n'
    socket.receive({ type: 'offer', from: 'remote-peer', session_id: 'test-room', body: { sdp: fresh } })
    await nextTurn()
    assert.equal(remoteDescriptions, 2)
    assert.equal(answersCreated, 2)
  } finally {
    client?.disconnect()
    globalThis.WebSocket = originalWebSocket
    globalThis.RTCPeerConnection = originalRTCPeerConnection
  }
})
