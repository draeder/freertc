// Watching a network: who is in it, in every room, pushed as it changes.
//
// A watcher (an app's console, say) opens one WebSocket to /watch?network=a&network=b and hears:
//
//   { t: "peers", network, peers: [{ id, room, role?, rest? }] }   on opening: who is here now
//   { t: "join",  network, id, room, role? }                        a peer arrived (or its role changed)
//   { t: "leave", network, id, room }                               a peer left
//   { t: "rest",  network, id, room, until }                        a peer let go of the relay on purpose
//                                                                   (its mesh is healthy), and no peer on
//                                                                   the relay names it: in the room until
//                                                                   `until` unless it says more
//
// A peer on the relay names its live mesh neighbours (freertc's reportMembers): those are in the room by
// name whether or not they hold a socket here, and leave the moment no one names them.
//
// Each relay tells of the peers it has; a watcher watches every relay it knows. The relay never asks
// anything to keep a watch going: a change it already handles is told as it happens, and nothing runs on a
// timer (a resting peer's lease ends at `until`, which the watcher keeps). On a Worker the socket hibernates
// like a peer's, so a quiet watch costs nothing and what the relay sends is not billed.

export const WATCH_PATH = "/watch";
export const MAX_WATCHED_NETWORKS = 20;
const NETWORK = /^[\w.:-]{1,128}$/;

/** The networks a watch asks for (from its URL), or an error. */
export function watchedNetworks(url) {
  const networks = [...new Set(url.searchParams.getAll("network").map((n) => n.trim()).filter(Boolean))];
  if (!networks.length) return { error: "Name a network: /watch?network=<network>" };
  if (networks.length > MAX_WATCHED_NETWORKS) return { error: `At most ${MAX_WATCHED_NETWORKS} networks a watch` };
  if (!networks.every((n) => NETWORK.test(n))) return { error: "A network is letters, digits, . _ : and -, up to 128" };
  return { networks };
}

export function createNetworkWatch() {
  const byNetwork = new Map(); // network -> Set of sockets

  function send(network, message) {
    const sockets = byNetwork.get(network);
    if (!sockets?.size) return;
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      try { socket.send(text); } catch { /* closing: its close takes it out */ }
    }
  }

  return {
    add(socket, networks) {
      for (const network of networks) {
        if (!byNetwork.has(network)) byNetwork.set(network, new Set());
        byNetwork.get(network).add(socket);
      }
    },
    remove(socket) {
      for (const [network, sockets] of byNetwork) {
        sockets.delete(socket);
        if (!sockets.size) byNetwork.delete(network);
      }
    },
    clear() { byNetwork.clear(); },
    watched(network) { return (byNetwork.get(network)?.size ?? 0) > 0; },
    /** A live peer: { peerId, network, room, role }. */
    joined(peer) {
      send(peer.network, { t: "join", network: peer.network, id: peer.peerId, room: peer.room, ...(peer.role ? { role: peer.role } : {}) });
    },
    left(peer) {
      send(peer.network, { t: "leave", network: peer.network, id: peer.peerId, room: peer.room });
    },
    rested(peer, until) {
      send(peer.network, { t: "rest", network: peer.network, id: peer.peerId, room: peer.room, until });
    },
  };
}

/**
 * Who a network has here: its live peers, and the peers resting off the relay whose lease has not ended.
 * `live` is the relay's map of live peers, `resting` its map of [network, room, peerId] keys to lease ends.
 */
export function networkSnapshot(network, live, resting, members = new Map(), now = Date.now()) {
  const peers = new Map();
  for (const peer of live.values()) {
    if (peer.network !== network || peer.local) continue;
    peers.set(`${peer.room}\n${peer.peerId}`, { id: peer.peerId, room: peer.room, ...(peer.role ? { role: peer.role } : {}) });
  }
  // Peers a peer on the relay names as its live mesh neighbours (they let go of the relay, or never held it).
  for (const m of members.values()) {
    if (m.network !== network) continue;
    for (const id of m.ids) if (!peers.has(`${m.room}\n${id}`)) peers.set(`${m.room}\n${id}`, { id, room: m.room });
  }
  for (const [key, until] of resting) {
    if (until <= now) continue;
    let parts;
    try { parts = JSON.parse(key); } catch { continue; }
    const [net, room, id] = parts;
    if (net !== network || peers.has(`${room}\n${id}`)) continue;
    peers.set(`${room}\n${id}`, { id, room, rest: until });
  }
  return { t: "peers", network, peers: [...peers.values()] };
}
