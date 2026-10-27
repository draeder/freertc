# Cloud and local relays

freertc relays come in two kinds, which run the same code and join the same
Kademlia overlay:

- **Cloud relays** are Cloudflare Workers (peer.ooo, decentralize.ooo, …). They
  have public addresses, and every request, Durable Object message and D1 query
  counts against a plan's daily limits.
- **Local relays** run on your own machine (`node scripts/node-relay.mjs`),
  usually behind NAT. They cost nothing per request.

The design goal is that cloud relays **introduce and point**, and local relays
**carry the traffic**: a peer that can use a local relay does, and a local relay
talks to its clients and to other local relays directly, not through the cloud.

## One relay ID

A relay with a federation identity is known everywhere by its **node ID**, the
SHA-256 of its signing key:

| Where | What |
| --- | --- |
| Kademlia overlay | routing buckets, signed node and provider records |
| Tunnel address | `wss://<home>/t/<node id>/ws` for a relay behind NAT |
| `/health` | `node_id`, and `relay_peer_id` (the relay's PSP identity) is the same |
| Relay registry | `GET /api/v1/relays` lists each relay's `node_id` |
| Discovered peers | each remote peer carries `relay_node_id` beside `relay_url` |
| Clients | PeerPigeon ranks relays by node ID |

A relay without an identity keeps `SHA-256(domain)`. Before 0.5.0 the PSP
identity was always the domain hash, so a relay behind NAT signed its frames as
its tunnel home and clients could not tell the two apart.

## Pointers

A relay's signed node record says what it is and how to reach it:

```json
{
  "node_id": "…",
  "url": "wss://peer.ooo/t/<node id>/ws",
  "relay_kind": "local",
  "reach": [
    { "via": "punch",  "url": "https://peer.ooo/t/<node id>/api/v1/punch/offer" },
    { "via": "tunnel", "url": "wss://peer.ooo/t/<node id>/ws" }
  ],
  "signature": "…"
}
```

- `relay_kind` is `cloud` (the default) or `local` (a Node relay, `RELAY_KIND`).
- `reach` lists ways in, most preferred first: `punch` (a direct data channel),
  `tunnel` (through the tunnel home), `direct` (a public address). A relay can
  only point at its own tunnel, and a record whose `reach` is not in normal form
  fails verification.
- Both fields are covered by the record's signature. Relays on older code store
  and pass the new records on unchanged, and records without the fields still verify.

## Punched connections

A relay behind NAT keeps one WebSocket open to its tunnel home. The home can
therefore carry an introduction without a rendezvous store or polling:

1. The client creates an `RTCPeerConnection` and a data channel, and waits for
   ICE gathering to finish so the offer holds every candidate.
2. It posts the offer to `https://<home>/t/<node id>/api/v1/punch/offer` as a
   `text/plain` request (a simple request, so no CORS preflight).
3. The tunnel delivers it to the local relay, which answers with a complete
   answer in the response.
4. Both sides' packets open the path. The relay protocol (PSP) then runs over the
   data channel, with the same frames a WebSocket would carry.

The home sees **one request per introduction** and nothing after it. If the
punch does not open (no WebRTC on the relay, or a NAT that will not punch), the
client uses the tunnel WebSocket and does not try that relay again for ten
minutes. There is no TURN; a pair of symmetric NATs falls back to the tunnel.

- Client: `openRelaySocket` in `src/client.js` does this for any `/t/<id>/ws`
  URL when WebRTC is available. `createSignalingClient({ relayPunch: false })`
  turns it off.
- Relay: `src/punch/offer.js`. node-relay enables it when `werift` (an optional
  dependency) is installed; `FREERTC_PUNCH=off` turns it off.

## Links between local relays

Two local relays behind NAT reach each other through their tunnel homes, so
every DHT lookup, peer query and forwarded signal between them used to cross a
cloud relay twice. A Node relay now keeps **links** to other local relays it has
verified through the overlay:

- **Which relays:** at most eight, one per XOR bucket first, as Kademlia keeps
  its contacts. Only the relay with the lower node ID dials, so a pair makes one link.
- **Over what:** a punched data channel (label `freertc-federation`), introduced
  once through the other relay's tunnel; or a WebSocket to its LAN address
  (`/api/v1/link`).
- **Authenticated:** each side sends a fresh nonce, and the other answers with
  its signed node record and a signature over that nonce. Nothing else crosses
  until both sides have proved their keys.
- **Used how:** the relay's `fetch` is wrapped, so a federation call to a linked
  relay's tunnel URL goes over the link. Everything else is unchanged.

**LAN discovery.** When `HOST` is a LAN address (for example `0.0.0.0`), relays
broadcast a UDP beacon on port 41235 (`FREERTC_LAN_PORT`) and link over the LAN.
A beacon is only a hint, because the link itself is authenticated. Loopback is
never used, and nothing learned on the LAN is stored in the overlay: a public
relay still never publishes or federates a private address.

## How a client chooses its relay

PeerPigeon (`src/relay-choice.ts`) chooses relays for the room, not just for the peer:

1. **Candidates:** the room's five relays closest to the key the relays publish
   the room under. Each relay counts as four points in the ID space, which evens
   out how much of the space each one owns.
2. **Tiers:** a healthy local relay comes before every cloud relay. Healthy means
   under 5% failed joins and under 90% of capacity.
3. **Score**, lower wins: join time, failure rate and load, plus a penalty for a
   relay reachable only through its tunnel. Ties go to XOR distance from the peer ID.
4. **Hysteresis:** a peer keeps its previous relay unless another is in a better
   tier or is at least 30% better.

Measurements come from the peer's own joins, stored in localStorage, and from
neighbours: each peer hands its own measurements to every new neighbour in one
direct frame, and again every ten minutes. A peer's own measurements count three
times what others share.

## What it costs

Measured with `wurl --cost` on Node relays running this code, which counts what
Cloudflare would bill. Figures are per peer joining, for 10 peers in one room:

| Setup | Worker requests | Billed DO requests | D1 queries |
| --- | --- | --- | --- |
| Local relay, peers through its tunnel (before) | 8.4 | 5.3 | 19.0 |
| Local relay, peers punched (now) | 1.6 | 1.1 | 1.6 |
| Two local relays on different homes, links off | 23.3 | 23.2 | 3.2 |
| Two local relays on different homes, links on | 2.2 | 1.1 | 3.2 |
| Half on a cloud relay, half on a local one (before) | 20.3 | 15.1 | 27.8 |
| Half on a cloud relay, half punched to a local one (now) | 8.5 | 7.4 | 8.4 |

What remains is the introduction (one tunnel request per punched client) and the
DHT. Discovers for one room within 5 s share one overlay lookup.

## node-relay settings

| Variable | Default | Effect |
| --- | --- | --- |
| `FREERTC_FEDERATION` | `on` | `off` runs a standalone relay |
| `FREERTC_PUBLIC` | `true` | a public relay never federates a loopback or private address |
| `FREERTC_TUNNEL` | `on` | a public relay behind NAT takes a public address through a tunnel |
| `FREERTC_TUNNEL_HOMES` | the bootstrap relays | relays to tunnel through, in order |
| `FREERTC_PUNCH` | `on` | accept punched connections (needs `werift`) |
| `FREERTC_LINKS` | `on` | link to other local relays |
| `FREERTC_LAN` | `on` | find relays on this network (only when `HOST` is a LAN address) |
| `FREERTC_LAN_PORT` | `41235` | UDP port for LAN beacons |
| `RELAY_KIND` | `local` | what this relay tells clients it is |

`GET /debug/cost` on a Node relay returns what it would have cost as a Cloudflare
Worker: Worker requests, DO requests and messages, and D1 reads and writes, with
a per-path tally.
