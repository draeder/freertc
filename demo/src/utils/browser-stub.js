/**
 * Browser stub for Node-only packages marked as
 * false in its dependency's browser field (bittorrent-dht, bittorrent-lsd).
 * They are not used in browser WebRTC-based connections.
 */
export class Client {
  on() { return this }
  once() { return this }
  emit() {}
  removeListener() {}
  destroy() {}
  lookup() {}
  announce() {}
}
export default { Client }
