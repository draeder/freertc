/* SHA-1, for the WebSocket handshake only (Sec-WebSocket-Accept). */
#ifndef FREERTC_SHA1_H
#define FREERTC_SHA1_H
#include <stddef.h>
#include <stdint.h>
void sha1(const void *data, size_t len, uint8_t out[20]);
#endif
