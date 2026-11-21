/*
 * FreeRTC relay core, in C, for small devices (the ESP32-C6) and for testing on Linux.
 *
 * It speaks PSP as src/index.js does, without federation: peers announce in a Network and Room, are
 * listed to each other (peer_list), and their negotiation messages (offer, answer, ice_candidate, ...)
 * are passed to the peer they name, or held briefly for a peer that is away. Signaling only: no data
 * goes through it but these messages.
 *
 * It has no I/O of its own. The platform (relay_platform) gives it a clock, randomness and a way to send
 * on or close a connection; the platform calls relay_message for each text frame, relay_closed when a
 * connection ends, and relay_tick about once a second.
 */
#ifndef FREERTC_RELAY_H
#define FREERTC_RELAY_H

#include <stddef.h>
#include <stdint.h>

#ifndef RELAY_MAX_CONNS
#define RELAY_MAX_CONNS 16          /* connections at once (each one is one peer) */
#endif
#ifndef RELAY_MAX_PEERS
#define RELAY_MAX_PEERS 24          /* announcements kept (live peers, and ones whose lease runs on) */
#endif
#ifndef RELAY_MAX_MESSAGE
#define RELAY_MAX_MESSAGE (64 * 1024) /* the largest message taken, as src/index.js */
#endif
#ifndef RELAY_QUEUE_BYTES
#define RELAY_QUEUE_BYTES (48 * 1024) /* held messages for peers that are away, in all */
#endif
#ifndef RELAY_QUEUE_COUNT
#define RELAY_QUEUE_COUNT 48
#endif

typedef struct {
  /* Milliseconds since 1970 (PSP timestamps are wall-clock). */
  int64_t (*now_ms)(void *ctx);
  /* n random bytes. */
  void (*random)(void *ctx, uint8_t *out, size_t n);
  /* Send a text frame on connection `conn`. Returns 0 when sent. */
  int (*send)(void *ctx, int conn, const char *data, size_t len);
  /* Close connection `conn` with a WebSocket close code. */
  void (*close)(void *ctx, int conn, int code, const char *reason);
  /* A line for the log (may be NULL). */
  void (*log)(void *ctx, const char *line);
  void *ctx;
} relay_platform;

/* Start the relay. `relay_url` is its public wss:// address, or NULL for "localhost": its peer id is the
 * SHA-256 of that host name, as relays elsewhere work it out. */
void relay_init(const relay_platform *platform, const char *relay_url);

/* A connection opened; returns 0, or -1 when the relay is full (the platform should close it). */
int relay_opened(int conn);
/* A text frame arrived on `conn`. */
void relay_message(int conn, const char *data, size_t len);
/* `conn` closed (or failed). */
void relay_closed(int conn);
/* About once a second: leases and held messages age out. */
void relay_tick(void);

/* This relay's peer id (64 hex). */
const char *relay_peer_id(void);

typedef struct { int conns; int peers; int queued; size_t queued_bytes; uint32_t delivered; uint32_t held; uint32_t dropped; } relay_stats;
relay_stats relay_get_stats(void);

#endif
