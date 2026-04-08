import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignalingClient } from './signalingClient.js'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

class FakeDataChannel {
  constructor() {
    this.readyState = 'open'
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
  }

  send() {}

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }
}

class FakeRTCPeerConnection {
  static instances = []

  constructor(config = {}) {
    this.config = config
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.iceConnectionState = 'new'
    this.remoteDescription = null
    this.localDescription = null
    this.onicecandidate = null
    this.onconnectionstatechange = null
    this.oniceconnectionstatechange = null
    this.ondatachannel = null
    this.addIceCandidateCalls = []
    this.__offerRetryTimer = null
    FakeRTCPeerConnection.instances.push(this)
  }

  createDataChannel() {
    return new FakeDataChannel()
  }

  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' }
  }

  async setLocalDescription(desc) {
    if (desc.type === 'offer') {
      this.signalingState = 'have-local-offer'
      this.localDescription = desc
      return
    }

    if (desc.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error('no pending remote description')
      }
      this.signalingState = 'stable'
      this.localDescription = desc
    }
  }

  async setRemoteDescription(desc) {
    if (desc.type === 'offer') {
      this.remoteDescription = desc
      this.signalingState = 'have-remote-offer'
      return
    }

    if (desc.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error('invalid signaling state for answer')
      }
      this.remoteDescription = desc
      this.signalingState = 'stable'
    }
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' }
  }

  async addIceCandidate(candidate) {
    this.addIceCandidateCalls.push(candidate)
  }

  close() {
    this.signalingState = 'closed'
    this.connectionState = 'closed'
    this.onconnectionstatechange?.()
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createSignalingClient signaling robustness', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeRTCPeerConnection.instances = []
    globalThis.WebSocket = FakeWebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not re-answer duplicate offers and avoids local-answer errors', async () => {
    const logs = []
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onLog: (msg) => logs.push(msg),
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    const offerMsg = {
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'same-offer-sdp' },
    }

    ws.receive(offerMsg)
    await flushMicrotasks()

    // Duplicate should not trigger another answer replay.
    ws.receive(offerMsg)
    await flushMicrotasks()

    let answers = ws.sent.filter((msg) => msg.type === 'relay' && msg.relayType === 'answer')
    expect(answers.length).toBe(1)
    expect(logs.some((line) => line.includes('Failed to set local answer'))).toBe(false)

    client.disconnect()
  })

  it('queues candidate that arrives before offer and applies it after offer', async () => {
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'candidate',
      payload: { candidate: 'early-candidate' },
    })

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'offer-after-candidate' },
    })

    await flushMicrotasks()

    expect(FakeRTCPeerConnection.instances.length).toBe(1)
    const pc = FakeRTCPeerConnection.instances[0]
    expect(pc.addIceCandidateCalls).toEqual([{ candidate: 'early-candidate' }])

    client.disconnect()
  })

  it('dedupes repeated bootstrap candidate logs with unchanged count', async () => {
    const logs = []
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onLog: (msg) => logs.push(msg),
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    ws.receive({ type: 'bootstrap_candidates', candidates: [] })
    ws.receive({ type: 'bootstrap_candidates', candidates: [] })
    ws.receive({ type: 'bootstrap_candidates', candidates: [{ peerId: 'peer-b' }] })
    ws.receive({ type: 'bootstrap_candidates', candidates: [{ peerId: 'peer-b' }] })

    const bootstrapLogs = logs.filter((msg) => msg.includes('bootstrap candidates'))
    expect(bootstrapLogs).toEqual([
      '[signal] received 0 bootstrap candidates',
      '[signal] received 1 bootstrap candidates',
    ])

    client.disconnect()
  })

  it('reuses peer connection after failed state before processing next offer', async () => {
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'offer-1' },
    })

    await flushMicrotasks()
    expect(FakeRTCPeerConnection.instances.length).toBe(1)

    const firstPc = FakeRTCPeerConnection.instances[0]
    firstPc.connectionState = 'failed'
    firstPc.onconnectionstatechange?.()

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'offer-2' },
    })

    await flushMicrotasks()
    expect(FakeRTCPeerConnection.instances.length).toBe(1)

    client.disconnect()
  })

  it('uses browser default ICE config for responder-created connections', async () => {
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'offer-ice-config' },
    })

    await flushMicrotasks()
    expect(FakeRTCPeerConnection.instances.length).toBe(1)
    expect(FakeRTCPeerConnection.instances[0].config.iceServers ?? []).toEqual([])

    client.disconnect()
  })

  it('delivers plain text data channel payloads to the app layer', async () => {
    const received = []
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onDataMessage: ({ data }) => received.push(data),
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    ws.receive({
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'offer-text-message' },
    })

    await flushMicrotasks()

    const pc = FakeRTCPeerConnection.instances[0]
    pc.ondatachannel?.({ channel: new FakeDataChannel() })
    pc._dataChannel = null
    const inboundChannel = pc.ondatachannel ? null : null

    const attachedChannel = { readyState: 'open', onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }
    pc.ondatachannel?.({ channel: attachedChannel })

    attachedChannel.onmessage?.({ data: 'hello over rtc' })

    expect(received).toEqual(['hello over rtc'])

    client.disconnect()
  })

  it('does not replay duplicate answers for duplicate offers after connection is established', async () => {
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    const offerMsg = {
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'offer',
      payload: { type: 'offer', sdp: 'connected-offer-sdp' },
    }

    ws.receive(offerMsg)
    await flushMicrotasks()

    const pc = FakeRTCPeerConnection.instances[0]
    pc.connectionState = 'connected'
    pc.iceConnectionState = 'connected'

    ws.receive(offerMsg)
    await flushMicrotasks()

    const answers = ws.sent.filter((msg) => msg.type === 'relay' && msg.relayType === 'answer')
    expect(answers.length).toBe(1)

    client.disconnect()
  })

  it('ignores duplicate answer bursts while an answer apply is in flight', async () => {
    const logs = []
    const client = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-1',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onLog: (msg) => logs.push(msg),
    })

    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ type: 'registered', peerId: 'peer-a', networkId: 'room-1' })

    await client.initiateConnection('peer-b', [{ urls: 'stun:stun.l.google.com:19302' }])
    await flushMicrotasks()

    const answerMsg = {
      type: 'incoming_relay',
      fromPeerId: 'peer-b',
      relayType: 'answer',
      payload: { type: 'answer', sdp: 'answer-sdp' },
    }

    ws.receive(answerMsg)
    ws.receive(answerMsg)
    ws.receive(answerMsg)
    await flushMicrotasks()

    expect(logs.some((line) => line.includes('setRemoteDescription(answer) failed'))).toBe(false)

    client.disconnect()
  })
})
