/* SHA-256 (FIPS 180-4), small and portable: the relay's peer id is the SHA-256 of its host name. */
#ifndef FREERTC_SHA256_H
#define FREERTC_SHA256_H
#include <stddef.h>
#include <stdint.h>
void sha256(const void *data, size_t len, uint8_t out[32]);
#endif
