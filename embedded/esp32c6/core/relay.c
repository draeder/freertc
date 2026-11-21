/*
 * FreeRTC relay core: src/index.js's handling of PSP messages, without federation, in fixed memory.
 * See relay.h. Where this differs from src/index.js, it says why.
 */
#include "relay.h"
#include "sha256.h"
#include "cJSON.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PSP_VERSION "1.0"
#define DEFAULT_TTL_MS 30000
#define MAX_TTL_MS 120000
#define MAX_BATCH 50
#define ABSENT_PEER_MS 60000
#define RELAY_IDLE_PEER_MS (10 * 60000)
#define CLEANUP_INTERVAL_MS 60000

#define NET_LEN 96
#define ROOM_LEN 160
#define ID_LEN 96
#define ROLE_LEN 33

/* ---------------- state ---------------- */

typedef struct {
  bool used;
  int generation;           /* newer connections win a peer id (claimLivePeer) */
  bool has_key;             /* the peer this connection last spoke for (peerKey) */
  char network[NET_LEN], room[ROOM_LEN], peer[ID_LEN];
  bool subscribed;          /* in its scope's subscribers (networkSubscribers) */
  char sub_network[NET_LEN], sub_room[ROOM_LEN];
} conn_t;

typedef struct {
  bool used;
  char network[NET_LEN], room[ROOM_LEN], peer[ID_LEN];
  int conn;                 /* the live connection (livePeers), or -1 */
  int conn_generation;
  bool announced;           /* a row in psp_announcements */
  int64_t expires_ms, updated_ms;
  char role[ROLE_LEN];
} peer_t;

typedef struct {
  bool used;
  uint32_t key;             /* (network, room, to) */
  char *json;
  size_t len;
  int64_t expires_ms, created_ms;
} held_t;

/* Peers that left (a goodbye), peers resting off the relay (relay_idle), and when each sender was last
 * told a peer is gone: kept as hashes of their keys, small and bounded. */
typedef struct { uint32_t key; int64_t until_ms; } mark_t;
#define MARKS 32

static relay_platform P;
static char relay_id[65];
static conn_t conns[RELAY_MAX_CONNS];
static peer_t peers[RELAY_MAX_PEERS];
static held_t held[RELAY_QUEUE_COUNT];
static size_t held_bytes;
static mark_t absent[MARKS], idle[MARKS], told[MARKS];
static int next_generation;
static int64_t last_cleanup;
static relay_stats stats;

static int64_t now(void) { return P.now_ms(P.ctx); }
static void logf_(const char *fmt, ...) {
  if (!P.log) return;
  char line[200];
  va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof line, fmt, ap); va_end(ap);
  P.log(P.ctx, line);
}

static uint32_t fnv(uint32_t h, const char *s) {
  for (; *s; s++) { h ^= (uint8_t)*s; h *= 16777619u; }
  h ^= 0xff; h *= 16777619u; /* a separator, so ("ab","c") and ("a","bc") differ */
  return h;
}
static uint32_t key3(const char *a, const char *b, const char *c) { return fnv(fnv(fnv(2166136261u, a), b), c); }

static void mark_set(mark_t *m, uint32_t key, int64_t until) {
  int slot = -1, oldest = 0;
  for (int i = 0; i < MARKS; i++) {
    if (m[i].key == key && m[i].until_ms) { slot = i; break; }
    if (slot < 0 && m[i].until_ms <= now()) slot = i;
    if (m[i].until_ms < m[oldest].until_ms) oldest = i;
  }
  if (slot < 0) slot = oldest;
  m[slot].key = key; m[slot].until_ms = until;
}
static int64_t mark_get(const mark_t *m, uint32_t key) {
  for (int i = 0; i < MARKS; i++) if (m[i].key == key && m[i].until_ms > now()) return m[i].until_ms;
  return 0;
}
static void mark_clear(mark_t *m, uint32_t key) {
  for (int i = 0; i < MARKS; i++) if (m[i].key == key) m[i].until_ms = 0;
}

/* ---------------- JSON out ---------------- */

typedef struct { char *p; size_t len, cap; bool failed; } sb_t;
static void sb_put(sb_t *b, const char *s, size_t n) {
  if (b->failed) return;
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap * 2 : 512;
    while (cap < b->len + n + 1) cap *= 2;
    char *p = realloc(b->p, cap);
    if (!p) { b->failed = true; return; }
    b->p = p; b->cap = cap;
  }
  memcpy(b->p + b->len, s, n); b->len += n; b->p[b->len] = 0;
}
static void sb_s(sb_t *b, const char *s) { sb_put(b, s, strlen(s)); }
static void sb_f(sb_t *b, const char *fmt, ...) {
  char tmp[96]; va_list ap; va_start(ap, fmt); int n = vsnprintf(tmp, sizeof tmp, fmt, ap); va_end(ap);
  if (n > 0) sb_put(b, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}
/* A JSON string, quoted and escaped. */
static void sb_q(sb_t *b, const char *s) {
  sb_put(b, "\"", 1);
  for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
    if (*c == '"' || *c == '\\') { char e[2] = { '\\', (char)*c }; sb_put(b, e, 2); }
    else if (*c < 0x20) sb_f(b, "\\u%04x", *c);
    else sb_put(b, (const char *)c, 1);
  }
  sb_put(b, "\"", 1);
}

static void uuid(char out[37]) {
  uint8_t r[16];
  P.random(P.ctx, r, sizeof r);
  r[6] = (r[6] & 0x0f) | 0x40; r[8] = (r[8] & 0x3f) | 0x80;
  snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15]);
}

/* The envelope's head: {"psp_version":"1.0","type":T,"network":N,"session_id":R,"from":relay,"to":TO,
 * "message_id":…,"timestamp":…,"ttl_ms":30000 — the caller adds the rest and the closing brace. A NULL
 * network leaves network and session_id out (src/index.js's error for a message it can't read); a NULL
 * `to` writes null. */
static void head(sb_t *b, const char *type, const char *network, const char *room, const char *to) {
  char id[37]; uuid(id);
  sb_s(b, "{\"psp_version\":\"" PSP_VERSION "\",\"type\":"); sb_q(b, type);
  if (network) { sb_s(b, ",\"network\":"); sb_q(b, network); sb_s(b, ",\"session_id\":"); sb_q(b, room); }
  sb_s(b, ",\"from\":"); sb_q(b, relay_id);
  sb_s(b, ",\"to\":"); if (to) sb_q(b, to); else sb_s(b, "null");
  sb_s(b, ",\"message_id\":"); sb_q(b, id);
  sb_f(b, ",\"timestamp\":%lld,\"ttl_ms\":%d", (long long)now(), DEFAULT_TTL_MS);
}

static int send_sb(int conn, sb_t *b) {
  int r = -1;
  if (!b->failed && b->p) r = P.send(P.ctx, conn, b->p, b->len);
  free(b->p);
  return r;
}

static void send_error(int conn, const char *network, const char *room, const char *to, const char *error) {
  sb_t b = { 0 };
  head(&b, "error", network, room, to);
  sb_s(&b, ",\"body\":{\"error\":"); sb_q(&b, error); sb_s(&b, "}}");
  send_sb(conn, &b);
}

/* ---------------- peers ---------------- */

static peer_t *peer_find(const char *network, const char *room, const char *id) {
  for (int i = 0; i < RELAY_MAX_PEERS; i++) {
    peer_t *p = &peers[i];
    if (p->used && !strcmp(p->peer, id) && !strcmp(p->room, room) && !strcmp(p->network, network)) return p;
  }
  return NULL;
}
static void peer_free_if_unused(peer_t *p) {
  if (p->used && p->conn < 0 && !p->announced) p->used = false;
}
static peer_t *peer_get(const char *network, const char *room, const char *id) {
  peer_t *p = peer_find(network, room, id);
  if (p) return p;
  int64_t t = now();
  for (int i = 0; i < RELAY_MAX_PEERS; i++) {
    peer_t *q = &peers[i];
    if (q->used && q->conn < 0 && q->announced && q->expires_ms <= t) q->used = false; /* a lapsed lease */
    if (!q->used) {
      memset(q, 0, sizeof *q);
      q->used = true; q->conn = -1;
      snprintf(q->network, NET_LEN, "%s", network); snprintf(q->room, ROOM_LEN, "%s", room); snprintf(q->peer, ID_LEN, "%s", id);
      return q;
    }
  }
  return NULL;
}

/* claimLivePeer: a connection newer than the one that holds this peer id takes it over; an older one is
 * refused. */
static bool claim_live(peer_t *p, int conn) {
  if (p->conn >= 0 && p->conn != conn && p->conn_generation > conns[conn].generation) return false;
  p->conn = conn; p->conn_generation = conns[conn].generation;
  return true;
}
/* deleteLivePeerIfOwned */
static bool release_live(peer_t *p, int conn) {
  if (!p || p->conn != conn) return false;
  p->conn = -1;
  return true;
}

/* A peer list: the announced peers of a scope, by peer id, without `except`. */
static int cmp_peer(const void *a, const void *b) { return strcmp((*(peer_t *const *)a)->peer, (*(peer_t *const *)b)->peer); }
static void send_peer_list(int conn, const char *network, const char *room, const char *to, const char *except) {
  peer_t *list[RELAY_MAX_PEERS]; int n = 0;
  int64_t t = now();
  for (int i = 0; i < RELAY_MAX_PEERS; i++) {
    peer_t *p = &peers[i];
    if (p->used && p->announced && p->expires_ms > t && !strcmp(p->network, network) && !strcmp(p->room, room)
        && !(except && !strcmp(p->peer, except))) list[n++] = p;
  }
  qsort(list, n, sizeof list[0], cmp_peer); /* peersNearest cuts at 50; RELAY_MAX_PEERS is fewer */
  sb_t b = { 0 };
  head(&b, "peer_list", network, room, to);
  sb_s(&b, ",\"body\":{\"peers\":[");
  for (int i = 0; i < n; i++) {
    if (i) sb_s(&b, ",");
    sb_s(&b, "{\"peer_id\":"); sb_q(&b, list[i]->peer);
    sb_s(&b, ",\"session_id\":"); sb_q(&b, list[i]->room);
    sb_f(&b, ",\"timestamp\":%lld", (long long)list[i]->updated_ms);
    if (list[i]->role[0]) { sb_s(&b, ",\"role\":"); sb_q(&b, list[i]->role); }
    sb_s(&b, "}");
  }
  sb_s(&b, "]}}");
  send_sb(conn, &b);
}
/* broadcastPeerList: the whole scope's list to every connection subscribed to it. */
static void broadcast_peer_list(const char *network, const char *room) {
  for (int c = 0; c < RELAY_MAX_CONNS; c++)
    if (conns[c].used && conns[c].subscribed && !strcmp(conns[c].sub_network, network) && !strcmp(conns[c].sub_room, room))
      send_peer_list(c, network, room, NULL, NULL);
}

/* peer-left: the announcement goes, and the scope hears. */
static void peer_left(peer_t *p) {
  char network[NET_LEN], room[ROOM_LEN];
  snprintf(network, sizeof network, "%s", p->network); snprintf(room, sizeof room, "%s", p->room);
  p->announced = false;
  peer_free_if_unused(p);
  broadcast_peer_list(network, room);
}

/* ---------------- held messages ---------------- */

static void held_drop(held_t *h) {
  if (!h->used) return;
  free(h->json); held_bytes -= h->len;
  h->used = false; h->json = NULL;
}
static void hold(const char *network, const char *room, const char *to, const char *json, size_t len, int ttl) {
  if (len > RELAY_QUEUE_BYTES) { stats.dropped++; return; }
  int64_t t = now();
  /* Room for it: the oldest held messages make way. */
  for (;;) {
    int free_slot = -1, oldest = -1;
    for (int i = 0; i < RELAY_QUEUE_COUNT; i++) {
      if (!held[i].used) { if (free_slot < 0) free_slot = i; continue; }
      if (oldest < 0 || held[i].created_ms < held[oldest].created_ms) oldest = i;
    }
    if (free_slot >= 0 && held_bytes + len <= RELAY_QUEUE_BYTES) {
      held_t *h = &held[free_slot];
      h->json = malloc(len + 1);
      if (!h->json) { stats.dropped++; return; }
      memcpy(h->json, json, len); h->json[len] = 0;
      h->len = len; h->used = true; h->key = key3(network, room, to);
      h->created_ms = t; h->expires_ms = t + (ttl > 0 ? (ttl < MAX_TTL_MS ? ttl : MAX_TTL_MS) : DEFAULT_TTL_MS);
      held_bytes += len; stats.held++;
      return;
    }
    if (oldest < 0) { stats.dropped++; return; }
    held_drop(&held[oldest]); stats.dropped++;
  }
}
/* deliverQueuedRelayMessages: oldest first, up to MAX_BATCH. */
static void deliver_held(int conn, const char *network, const char *room, const char *peer) {
  uint32_t key = key3(network, room, peer);
  int64_t t = now();
  for (int sent = 0; sent < MAX_BATCH; sent++) {
    held_t *next = NULL;
    for (int i = 0; i < RELAY_QUEUE_COUNT; i++)
      if (held[i].used && held[i].key == key && held[i].expires_ms > t && (!next || held[i].created_ms < next->created_ms)) next = &held[i];
    if (!next) return;
    if (P.send(P.ctx, conn, next->json, next->len) != 0) return;
    stats.delivered++;
    held_drop(next);
  }
}

/* tellSenderPeerGone: once a minute per (sender, target). */
static void tell_gone(int conn, const char *network, const char *room, const char *sender, const char *target) {
  uint32_t k = key3(network, room, sender) ^ (fnv(2166136261u, target) * 31u);
  if (mark_get(told, k)) return;
  mark_set(told, k, now() + ABSENT_PEER_MS);
  sb_t b = { 0 };
  head(&b, "error", network, room, sender);
  sb_s(&b, ",\"body\":{\"code\":\"target_not_connected\",\"reason\":\"no relay has this peer\",\"peer_id\":");
  sb_q(&b, target); sb_s(&b, "}}");
  send_sb(conn, &b);
}

/* ---------------- messages ---------------- */

static const char *const MESSAGE_TYPES[] = {
  "announce", "withdraw", "discover", "peer_list", "redirect",
  "connect_request", "connect_accept", "connect_reject", "offer", "answer", "ice_candidate", "ice_end", "renegotiate",
  "ping", "pong", "bye", "error", "ack", "ext", NULL,
};
static const char *const RELAY_TYPES[] = {
  "connect_request", "connect_accept", "connect_reject", "offer", "answer", "ice_candidate", "ice_end", "renegotiate",
  "bye", "error", "ack", "ext", "peer_list", "redirect", NULL,
};
static bool in(const char *const *set, const char *s) { for (; *set; set++) if (!strcmp(*set, s)) return true; return false; }

static const char *str(const cJSON *o, const char *k) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}
static bool blank(const char *s) { if (!s) return true; for (; *s; s++) if (*s != ' ' && *s != '\t' && *s != '\n' && *s != '\r') return false; return true; }
/* normalizeRoom: trimmed. */
static void trim_to(char *out, size_t cap, const char *s) {
  while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  size_t n = strlen(s);
  while (n && (s[n - 1] == ' ' || s[n - 1] == '\t' || s[n - 1] == '\n' || s[n - 1] == '\r')) n--;
  if (n >= cap) n = cap - 1;
  memcpy(out, s, n); out[n] = 0;
}

static bool valid_envelope(const cJSON *m) {
  const cJSON *ts = cJSON_GetObjectItemCaseSensitive(m, "timestamp");
  const char *v = str(m, "psp_version"), *type = str(m, "type");
  return cJSON_IsObject(m) && v && !strcmp(v, PSP_VERSION) && type && in(MESSAGE_TYPES, type)
    && !blank(str(m, "from")) && !blank(str(m, "network")) && !blank(str(m, "session_id"))
    && str(m, "message_id") && cJSON_IsNumber(ts);
}

/* What the connection last spoke for (handleWebSocket's peerKey, network, room, peerId). */
static void remember(conn_t *c, const char *network, const char *room, const char *peer) {
  c->has_key = true;
  snprintf(c->network, NET_LEN, "%s", network); snprintf(c->room, ROOM_LEN, "%s", room); snprintf(c->peer, ID_LEN, "%s", peer);
}

static void handle(int conn, const char *raw, size_t len, cJSON *m) {
  conn_t *c = &conns[conn];
  const char *network = str(m, "network"), *peer = str(m, "from"), *type = str(m, "type"), *to = str(m, "to");
  char room[ROOM_LEN]; trim_to(room, sizeof room, str(m, "session_id"));
  if (strlen(network) >= NET_LEN || strlen(peer) >= ID_LEN || strlen(str(m, "session_id")) >= ROOM_LEN) {
    send_error(conn, network, room, peer, "network, room or peer id too long for this relay");
    return;
  }
  const cJSON *body = cJSON_GetObjectItemCaseSensitive(m, "body");

  if (!strcmp(type, "announce")) {
    const char *instance = cJSON_IsObject(body) ? str(body, "instance_id") : NULL;
    if (!instance || strcmp(instance, network)) {
      send_error(conn, network, room, peer, "instance_id must match network");
      return;
    }
  }

  bool had_key = c->has_key;
  bool same_key = had_key && !strcmp(c->network, network) && !strcmp(c->room, room) && !strcmp(c->peer, peer);
  bool same_scope = had_key && !strcmp(c->network, network) && !strcmp(c->room, room);

  if (to && !*to) to = NULL; /* "" is no target, as in JavaScript */
  if (to && !strcmp(to, peer) && in(RELAY_TYPES, type)) { remember(c, network, room, peer); return; }

  /* Subscribe to the exact Network + Room scope. */
  if (!had_key || !same_scope) {
    c->subscribed = true;
    snprintf(c->sub_network, NET_LEN, "%s", network); snprintf(c->sub_room, ROOM_LEN, "%s", room);
  }

  peer_t *p = peer_get(network, room, peer);
  if (!p) { send_error(conn, network, room, peer, "relay full"); remember(c, network, room, peer); return; }
  if (!claim_live(p, conn)) {
    P.close(P.ctx, conn, 4001, "replaced_socket");
    remember(c, network, room, peer);
    return;
  }
  remember(c, network, room, peer);
  uint32_t pkey = key3(network, room, peer);

  if (!strcmp(type, "announce")) {
    bool heartbeat = same_key;
    mark_clear(absent, pkey); mark_clear(idle, pkey);
    /* createRegistrationAck */
    sb_t b = { 0 };
    head(&b, "ack", network, room, peer);
    sb_s(&b, ",\"reply_to\":"); sb_q(&b, str(m, "message_id"));
    sb_s(&b, ",\"body\":{\"status\":\"ok\",\"action\":\"announce\"}}");
    send_sb(conn, &b);
    /* upsertAnnouncement: rewritten when the role changed or less than half its lease is left. */
    const cJSON *ttlv = cJSON_GetObjectItemCaseSensitive(m, "ttl_ms");
    int ttl = cJSON_IsNumber(ttlv) && ttlv->valuedouble > 0 ? (int)ttlv->valuedouble : DEFAULT_TTL_MS;
    if (ttl > MAX_TTL_MS) ttl = MAX_TTL_MS;
    char role[ROLE_LEN] = "";
    const cJSON *caps = cJSON_IsObject(body) ? cJSON_GetObjectItemCaseSensitive(body, "capabilities") : NULL;
    const char *r = caps ? str(caps, "role") : NULL;
    if (r) { /* announcedRole: a short lowercase word */
      size_t n = strlen(r); bool ok = n > 0 && n <= 32;
      for (size_t i = 0; ok && i < n; i++) ok = (r[i] >= 'a' && r[i] <= 'z') || (r[i] >= '0' && r[i] <= '9') || (i > 0 && r[i] == '-');
      if (ok) snprintf(role, sizeof role, "%s", r);
    }
    int64_t t = now();
    if (!p->announced || strcmp(p->role, role) || (p->expires_ms - t) * 2 <= ttl) {
      p->announced = true; p->expires_ms = t + ttl; p->updated_ms = t;
      snprintf(p->role, sizeof p->role, "%s", role);
    }
    deliver_held(conn, network, room, peer);
    if (!heartbeat) broadcast_peer_list(network, room);

  } else if (!strcmp(type, "withdraw")) {
    const char *reason = cJSON_IsObject(body) ? str(body, "reason") : NULL;
    if (reason && !strcmp(reason, "relay_idle")) { mark_set(idle, pkey, now() + RELAY_IDLE_PEER_MS); mark_clear(absent, pkey); }
    else mark_set(absent, pkey, now() + ABSENT_PEER_MS);
    if (release_live(p, conn)) peer_left(p);

  } else if (!strcmp(type, "discover")) {
    send_peer_list(conn, network, room, peer, peer);

  } else if (!strcmp(type, "ext") && cJSON_IsObject(body) && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(body, "relay_request"))) {
    /* No requests to the relay itself here (no account store): answered unsupported, so nobody waits. */
    sb_t b = { 0 };
    head(&b, "ext", network, room, peer);
    sb_s(&b, ",\"reply_to\":"); sb_q(&b, str(m, "message_id"));
    sb_s(&b, ",\"body\":{\"ok\":false,\"error\":\"unsupported\",\"relay_response\":true,\"request_id\":");
    const cJSON *rid = cJSON_GetObjectItemCaseSensitive(body, "request_id");
    char *ridj = rid ? cJSON_PrintUnformatted(rid) : NULL;
    sb_s(&b, ridj ? ridj : "null"); free(ridj);
    sb_s(&b, "}}");
    send_sb(conn, &b);

  } else if (!strcmp(type, "ext") && cJSON_IsObject(body) && str(body, "action") && !strcmp(str(body, "action"), "relay_list")) {
    /* Another relay's list of relays: nothing to keep without federation. */

  } else if (!strcmp(type, "ping")) {
    sb_t b = { 0 };
    head(&b, "pong", network, room, peer);
    sb_s(&b, ",\"body\":{}}");
    send_sb(conn, &b);
    deliver_held(conn, network, room, peer);

  } else if (!strcmp(type, "bye")) {
    if (release_live(p, conn)) peer_left(p);

  } else if (in(RELAY_TYPES, type)) {
    if (!to || !strcmp(to, peer)) return;
    peer_t *target = peer_find(network, room, to);
    if (target && target->conn >= 0 && P.send(P.ctx, target->conn, raw, len) == 0) { stats.delivered++; return; }
    /* Not here. A peer resting off the relay gets it held; one that said goodbye doesn't, and its sender
     * is told once; any other is held, for when it comes back (src/index.js asks other relays first). */
    uint32_t tkey = key3(network, room, to);
    const cJSON *ttlv = cJSON_GetObjectItemCaseSensitive(m, "ttl_ms");
    int ttl = cJSON_IsNumber(ttlv) ? (int)ttlv->valuedouble : 0;
    if (mark_get(idle, tkey)) { hold(network, room, to, raw, len, ttl); return; }
    if (mark_get(absent, tkey)) { stats.dropped++; tell_gone(conn, network, room, peer, to); return; }
    hold(network, room, to, raw, len, ttl);
  }
}

/* ---------------- the platform's calls ---------------- */

void relay_init(const relay_platform *platform, const char *relay_url) {
  P = *platform;
  memset(conns, 0, sizeof conns); memset(peers, 0, sizeof peers);
  for (int i = 0; i < RELAY_QUEUE_COUNT; i++) held_drop(&held[i]);
  held_bytes = 0;
  /* relayPeerIdFor: the SHA-256 of the host name (lowercase, no trailing dot), "localhost" without one. */
  char host[128] = "localhost";
  if (relay_url) {
    const char *s = strstr(relay_url, "://");
    s = s ? s + 3 : relay_url;
    size_t n = 0;
    if (*s == '[') { while (s[n] && s[n] != ']' && n < sizeof host - 2) n++; if (s[n] == ']') n++; }
    else while (s[n] && s[n] != ':' && s[n] != '/' && s[n] != '?' && s[n] != '#' && n < sizeof host - 1) n++;
    if (n) {
      for (size_t i = 0; i < n; i++) host[i] = (s[i] >= 'A' && s[i] <= 'Z') ? s[i] + 32 : s[i];
      host[n] = 0;
      if (n > 1 && host[n - 1] == '.') host[n - 1] = 0;
    }
  }
  uint8_t d[32];
  sha256(host, strlen(host), d);
  for (int i = 0; i < 32; i++) snprintf(relay_id + 2 * i, 3, "%02x", d[i]);
  last_cleanup = now();
  logf_("FreeRTC relay %s (%s)", relay_id, host);
}

int relay_opened(int conn) {
  if (conn < 0 || conn >= RELAY_MAX_CONNS || conns[conn].used) return -1;
  memset(&conns[conn], 0, sizeof conns[conn]);
  conns[conn].used = true;
  conns[conn].generation = ++next_generation;
  return 0;
}

void relay_message(int conn, const char *data, size_t len) {
  if (conn < 0 || conn >= RELAY_MAX_CONNS || !conns[conn].used || !data || !len) return;
  if (len > RELAY_MAX_MESSAGE) return;
  cJSON *m = cJSON_ParseWithLength(data, len);
  if (!m) {
    sb_t b = { 0 };
    head(&b, "error", NULL, NULL, "client");
    sb_s(&b, ",\"body\":{\"error\":\"Invalid JSON\"}}");
    send_sb(conn, &b);
    return;
  }
  if (!valid_envelope(m)) {
    const char *from = str(m, "from");
    send_error(conn, NULL, NULL, from ? from : "unknown", "Invalid PSP envelope");
  } else {
    handle(conn, data, len, m);
  }
  cJSON_Delete(m);
}

void relay_closed(int conn) {
  if (conn < 0 || conn >= RELAY_MAX_CONNS || !conns[conn].used) return;
  conn_t *c = &conns[conn];
  if (c->has_key) {
    peer_t *p = peer_find(c->network, c->room, c->peer);
    if (release_live(p, conn)) { c->used = false; peer_left(p); }
  }
  /* Any other peer this connection held (it spoke for one id, then another) is let go too. */
  for (int i = 0; i < RELAY_MAX_PEERS; i++) if (peers[i].used && peers[i].conn == conn) { peers[i].conn = -1; peer_free_if_unused(&peers[i]); }
  memset(c, 0, sizeof *c);
}

void relay_tick(void) {
  int64_t t = now();
  if (t - last_cleanup < CLEANUP_INTERVAL_MS) return;
  last_cleanup = t;
  /* cleanupExpired */
  for (int i = 0; i < RELAY_MAX_PEERS; i++) {
    peer_t *p = &peers[i];
    if (p->used && p->announced && p->expires_ms <= t) { p->announced = false; peer_free_if_unused(p); }
  }
  for (int i = 0; i < RELAY_QUEUE_COUNT; i++) if (held[i].used && held[i].expires_ms <= t) held_drop(&held[i]);
}

const char *relay_peer_id(void) { return relay_id; }

relay_stats relay_get_stats(void) {
  relay_stats s = stats;
  s.conns = 0; s.peers = 0; s.queued = 0;
  for (int i = 0; i < RELAY_MAX_CONNS; i++) s.conns += conns[i].used;
  for (int i = 0; i < RELAY_MAX_PEERS; i++) s.peers += peers[i].used && peers[i].announced;
  for (int i = 0; i < RELAY_QUEUE_COUNT; i++) s.queued += held[i].used;
  s.queued_bytes = held_bytes;
  return s;
}
