import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSignalingClient } from './signalingClient.js'

class InMemorySignalServer {
  constructor() {
    this.byNetwork = new Map()
  }

  _network(networkId) {
    if (!this.byNetwork.has(networkId)) {
      this.byNetwork.set(networkId, new Set())
    }
    return this.byNetwork.get(networkId)
  }

  addSocket(socket) {
    this._network(socket.networkId).add(socket)
  }

  removeSocket(socket) {
    const net = this.byNetwork.get(socket.networkId)
    if (!net) return
    net.delete(socket)
  }

  handle(socket, msg) {
    switch (msg.type) {
      case 'register': {
        socket.peerId = msg.peerId
        socket.deliver({
          type: 'registered',
          peerId: msg.peerId,
          networkId: msg.networkId,
        })
        break
      }

      case 'get_bootstrap': {
        const net = this._network(socket.networkId)
        const excluded = new Set(msg.excludePeerIds ?? [])
        const candidates = []
        for (const ws of net.values()) {
          if (!ws.peerId) continue
          if (ws === socket) continue
          if (excluded.has(ws.peerId)) continue
          candidates.push({
            peerId: ws.peerId,
            lastSeenAt: Date.now(),
            capabilities: { role: 'browser' },
          })
        }
        socket.deliver({ type: 'bootstrap_candidates', candidates })
        break
      }

      case 'relay': {
        const net = this._network(socket.networkId)
        for (const ws of net.values()) {
          if (ws.peerId !== msg.toPeerId) continue
          ws.deliver({
            type: 'incoming_relay',
            fromPeerId: msg.fromPeerId,
            relayType: msg.relayType,
            payload: msg.payload,
          })
        }

        socket.deliver({
          type: 'relayed',
          toPeerId: msg.toPeerId,
          messageId: msg.messageId,
          via: 'memory',
        })
        break
      }

      case 'ping':
        socket.deliver({ type: 'pong', ts: Date.now() })
        break

      case 'unregister':
        socket.peerId = null
        break

      default:
        break
    }
  }
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static server = null

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.peerId = null

    const parsed = new URL(url)
    this.networkId = parsed.searchParams.get('networkId') ?? 'default'

    FakeWebSocket.server.addSocket(this)

    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data) {
    const msg = JSON.parse(data)
    FakeWebSocket.server.handle(this, msg)
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED
    FakeWebSocket.server.removeSocket(this)
    this.onclose?.({ code })
  }

  deliver(msg) {
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify(msg) })
    })
  }
}

class FakeDataChannel {
  constructor() {
    this.readyState = 'connecting'
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

  _open() {
    this.readyState = 'open'
    this.onopen?.()
  }
}

class FakeRTCPeerConnection {
  constructor() {
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.iceConnectionState = 'new'
    this.remoteDescription = null
    this.localDescription = null
    this.onicecandidate = null
    this.onconnectionstatechange = null
    this.oniceconnectionstatechange = null
    this.ondatachannel = null
    this._dataChannel = null
  }

  createDataChannel() {
    this._dataChannel = new FakeDataChannel()
    return this._dataChannel
  }

  async createOffer() {
    return { type: 'offer', sdp: `offer-${Math.random()}` }
  }

  async createAnswer() {
    return { type: 'answer', sdp: `answer-${Math.random()}` }
  }

  async setLocalDescription(desc) {
    this.localDescription = desc
    if (desc.type === 'offer') {
      this.signalingState = 'have-local-offer'
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable'
      this._transitionToConnectedSoon()
    }

    this.onicecandidate?.({ candidate: { candidate: 'candidate:1' } })
    this.onicecandidate?.({ candidate: null })
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer'
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable'
      this._transitionToConnectedSoon()
    }
  }

  async addIceCandidate() {}

  close() {
    this.signalingState = 'closed'
    this.connectionState = 'closed'
    this.onconnectionstatechange?.()
  }

  _transitionToConnectedSoon() {
    this.iceConnectionState = 'checking'
    this.oniceconnectionstatechange?.()

    queueMicrotask(() => {
      if (this.signalingState === 'closed') return
      this.iceConnectionState = 'connected'
      this.connectionState = 'connected'
      this.oniceconnectionstatechange?.()
      this.onconnectionstatechange?.()
      this._dataChannel?._open()
    })
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('peer connectivity integration', () => {
  beforeEach(() => {
    FakeWebSocket.server = new InMemorySignalServer()
    globalThis.WebSocket = FakeWebSocket
    globalThis.RTCPeerConnection = FakeRTCPeerConnection
  })

  afterEach(() => {
    FakeWebSocket.server = null
  })

  it('connects two peers end-to-end via signaling relay', async () => {
    const statesA = []
    const statesB = []

    const clientA = createSignalingClient({
      peerId: 'peer-a',
      networkId: 'room-int',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onConnectionStateChange: ({ state }) => statesA.push(state),
    })

    const clientB = createSignalingClient({
      peerId: 'peer-b',
      networkId: 'room-int',
      signalUrl: 'wss://your-domain.example/ws',
      autoConnect: true,
      onConnectionStateChange: ({ state }) => statesB.push(state),
    })

    await waitUntil(() => clientA.isRegistered && clientB.isRegistered)

    clientA.requestBootstrap(['peer-a'])
    clientB.requestBootstrap(['peer-b'])

    await clientA.initiateConnection('peer-b', [{ urls: 'stun:stun.l.google.com:19302' }])

    await waitUntil(() => statesA.includes('connected') && statesB.includes('connected'))

    expect(statesA).toContain('connected')
    expect(statesB).toContain('connected')

    clientA.disconnect()
    clientB.disconnect()
  })
})
