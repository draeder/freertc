/*
 * The relay core on Linux, for testing: a small WebSocket server (RFC 6455, plain ws://) on one thread.
 *
 *   ./freertc-c6-relay [port] [public wss:// url]
 *
 * ws://<host>:<port>/ws is the relay; GET / answers with its counts as JSON.
 */
#define _GNU_SOURCE
#include "relay.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include "sha1.h"

#define CONN_BUF (RELAY_MAX_MESSAGE + 64 * 1024)

typedef struct {
  int fd;                 /* -1: free */
  bool upgraded;
  uint8_t *in; size_t in_len;      /* bytes read, not yet handled */
  char *msg; size_t msg_len;       /* a fragmented message so far */
  bool closing;
} client_t;

static client_t clients[RELAY_MAX_CONNS];

static int64_t now_ms(void *ctx) { (void)ctx; struct timeval tv; gettimeofday(&tv, NULL); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }
static void rnd(void *ctx, uint8_t *out, size_t n) { (void)ctx; while (n) { ssize_t r = getrandom(out, n, 0); if (r > 0) { out += r; n -= (size_t)r; } } }
static void say(void *ctx, const char *line) { (void)ctx; fprintf(stderr, "%s\n", line); }

static int write_all(int fd, const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t w = send(fd, b, n, MSG_NOSIGNAL);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) { struct pollfd pf = { fd, POLLOUT, 0 }; if (poll(&pf, 1, 2000) <= 0) return -1; continue; }
      return -1;
    }
    b += w; n -= (size_t)w;
  }
  return 0;
}
static int send_frame(int fd, int opcode, const void *data, size_t len) {
  uint8_t h[10]; size_t hl = 2;
  h[0] = 0x80 | (uint8_t)opcode;
  if (len < 126) h[1] = (uint8_t)len;
  else if (len < 65536) { h[1] = 126; h[2] = len >> 8; h[3] = len & 0xff; hl = 4; }
  else { h[1] = 127; for (int i = 0; i < 8; i++) h[2 + i] = (uint8_t)((uint64_t)len >> (56 - 8 * i)); hl = 10; }
  if (write_all(fd, h, hl)) return -1;
  return len ? write_all(fd, data, len) : 0;
}

static void drop(int i) {
  if (clients[i].fd < 0) return;
  if (clients[i].upgraded) relay_closed(i);
  close(clients[i].fd);
  free(clients[i].in); free(clients[i].msg);
  memset(&clients[i], 0, sizeof clients[i]);
  clients[i].fd = -1;
}

static int p_send(void *ctx, int conn, const char *data, size_t len) {
  (void)ctx;
  if (conn < 0 || conn >= RELAY_MAX_CONNS || clients[conn].fd < 0 || !clients[conn].upgraded || clients[conn].closing) return -1;
  return send_frame(clients[conn].fd, 1, data, len);
}
static void p_close(void *ctx, int conn, int code, const char *reason) {
  (void)ctx;
  if (conn < 0 || conn >= RELAY_MAX_CONNS || clients[conn].fd < 0) return;
  uint8_t b[125]; size_t n = strlen(reason); if (n > 120) n = 120;
  b[0] = code >> 8; b[1] = code & 0xff; memcpy(b + 2, reason, n);
  send_frame(clients[conn].fd, 8, b, n + 2);
  clients[conn].closing = true;
}

static const char *B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64(const uint8_t *in, size_t n, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    out[o++] = B64[v >> 18 & 63]; out[o++] = B64[v >> 12 & 63];
    out[o++] = i + 1 < n ? B64[v >> 6 & 63] : '='; out[o++] = i + 2 < n ? B64[v & 63] : '=';
  }
  out[o] = 0;
}

static const char *header(const char *req, const char *name, char *out, size_t cap) {
  size_t nl = strlen(name);
  for (const char *l = strstr(req, "\r\n"); l && l[2]; l = strstr(l + 2, "\r\n")) {
    const char *s = l + 2;
    if (!strncasecmp(s, name, nl) && s[nl] == ':') {
      s += nl + 1; while (*s == ' ') s++;
      size_t n = strcspn(s, "\r\n"); if (n >= cap) n = cap - 1;
      memcpy(out, s, n); out[n] = 0;
      return out;
    }
  }
  return NULL;
}

/* An HTTP request: the WebSocket upgrade on /ws, or the counts on anything else. */
static void http(int i) {
  client_t *c = &clients[i];
  char *end = memmem(c->in, c->in_len, "\r\n\r\n", 4);
  if (!end) { if (c->in_len > 8192) drop(i); return; }
  size_t req_len = (size_t)(end - (char *)c->in) + 4;
  char req[8193]; memcpy(req, c->in, req_len < 8192 ? req_len : 8192); req[req_len < 8192 ? req_len : 8192] = 0;
  memmove(c->in, c->in + req_len, c->in_len - req_len); c->in_len -= req_len;
  char key[128], up[64];
  bool ws = !strncmp(req, "GET /ws", 7) && header(req, "Sec-WebSocket-Key", key, sizeof key) && header(req, "Upgrade", up, sizeof up) && !strcasecmp(up, "websocket");
  if (!ws) {
    relay_stats s = relay_get_stats();
    char body[300];
    int n = snprintf(body, sizeof body, "{\"ok\":true,\"relay\":\"%s\",\"conns\":%d,\"peers\":%d,\"held\":%d,\"delivered\":%u,\"dropped\":%u}\n",
      relay_peer_id(), s.conns, s.peers, s.queued, s.delivered, s.dropped);
    char resp[512];
    int m = snprintf(resp, sizeof resp, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", n, body);
    write_all(c->fd, resp, (size_t)m);
    drop(i);
    return;
  }
  if (relay_opened(i) != 0) { const char *r = "HTTP/1.1 503 Full\r\nContent-Length: 0\r\n\r\n"; write_all(c->fd, r, strlen(r)); drop(i); return; }
  char cat[200]; snprintf(cat, sizeof cat, "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
  uint8_t d[20]; sha1(cat, strlen(cat), d);
  char acc[32]; b64(d, 20, acc);
  char resp[300];
  int m = snprintf(resp, sizeof resp, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", acc);
  write_all(c->fd, resp, (size_t)m);
  c->upgraded = true;
}

/* WebSocket frames from a client (masked). */
static void frames(int i) {
  client_t *c = &clients[i];
  for (;;) {
    if (c->fd < 0 || c->in_len < 2) return;
    uint8_t *b = c->in;
    bool fin = b[0] & 0x80; int op = b[0] & 0x0f; bool masked = b[1] & 0x80;
    uint64_t len = b[1] & 0x7f; size_t hl = 2;
    if (len == 126) { if (c->in_len < 4) return; len = (uint64_t)b[2] << 8 | b[3]; hl = 4; }
    else if (len == 127) { if (c->in_len < 10) return; len = 0; for (int k = 0; k < 8; k++) len = len << 8 | b[2 + k]; hl = 10; }
    if (!masked || len > RELAY_MAX_MESSAGE) { drop(i); return; }
    if (c->in_len < hl + 4 + len) return;
    uint8_t *mask = b + hl, *data = b + hl + 4;
    for (uint64_t k = 0; k < len; k++) data[k] ^= mask[k & 3];
    if (op == 8) { send_frame(c->fd, 8, data, len >= 2 ? 2 : 0); drop(i); return; }
    if (op == 9) send_frame(c->fd, 10, data, (size_t)len);
    else if (op == 1 || op == 0 || op == 2) {
      if (c->msg_len + len > RELAY_MAX_MESSAGE) { drop(i); return; }
      char *m = realloc(c->msg, c->msg_len + len + 1);
      if (!m) { drop(i); return; }
      c->msg = m; memcpy(c->msg + c->msg_len, data, len); c->msg_len += len; c->msg[c->msg_len] = 0;
      if (fin) {
        if (op != 2) relay_message(i, c->msg, c->msg_len);
        if (clients[i].fd < 0) return;
        free(c->msg); c->msg = NULL; c->msg_len = 0;
      }
    }
    size_t used = hl + 4 + (size_t)len;
    memmove(c->in, c->in + used, c->in_len - used); c->in_len -= used;
    if (c->closing) { drop(i); return; }
  }
}

int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 8790;
  const char *url = argc > 2 ? argv[2] : NULL;
  relay_platform pf = { now_ms, rnd, p_send, p_close, say, NULL };
  relay_init(&pf, url);
  for (int i = 0; i < RELAY_MAX_CONNS; i++) clients[i].fd = -1;

  int ls = socket(AF_INET, SOCK_STREAM, 0), one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_ANY) };
  if (bind(ls, (struct sockaddr *)&a, sizeof a) || listen(ls, 16)) { perror("listen"); return 1; }
  fprintf(stderr, "Listening on 0.0.0.0:%d (ws://…/ws)\n", port);

  for (;;) {
    struct pollfd pf_[RELAY_MAX_CONNS + 1]; int idx[RELAY_MAX_CONNS + 1]; int n = 0;
    pf_[n].fd = ls; pf_[n].events = POLLIN; idx[n++] = -1;
    for (int i = 0; i < RELAY_MAX_CONNS; i++) if (clients[i].fd >= 0) { pf_[n].fd = clients[i].fd; pf_[n].events = POLLIN; idx[n++] = i; }
    int r = poll(pf_, n, 1000);
    relay_tick();
    if (r <= 0) continue;
    for (int k = 0; k < n; k++) {
      if (!pf_[k].revents) continue;
      if (idx[k] < 0) {
        int fd = accept(ls, NULL, NULL);
        if (fd < 0) continue;
        int slot = -1; for (int i = 0; i < RELAY_MAX_CONNS; i++) if (clients[i].fd < 0) { slot = i; break; }
        if (slot < 0) { close(fd); continue; }
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        clients[slot].fd = fd;
        clients[slot].in = malloc(CONN_BUF);
        continue;
      }
      int i = idx[k];
      client_t *c = &clients[i];
      if (c->fd < 0) continue;
      if (c->in_len >= CONN_BUF) { drop(i); continue; }
      ssize_t got = recv(c->fd, c->in + c->in_len, CONN_BUF - c->in_len, 0);
      if (got <= 0) { drop(i); continue; }
      c->in_len += (size_t)got;
      if (!c->upgraded) http(i);
      if (clients[i].fd >= 0 && clients[i].upgraded) frames(i);
    }
  }
}
