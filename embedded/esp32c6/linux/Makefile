# The relay core on Linux, for testing: make && ./freertc-c6-relay 8790
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter
CORE = ../core
CJSON = ../third_party/cjson
freertc-c6-relay: main.c sha1.c $(CORE)/relay.c $(CORE)/sha256.c $(CJSON)/cJSON.c $(CORE)/relay.h
	$(CC) $(CFLAGS) -I$(CORE) -I$(CJSON) -o $@ main.c sha1.c $(CORE)/relay.c $(CORE)/sha256.c $(CJSON)/cJSON.c
clean:
	rm -f freertc-c6-relay
.PHONY: clean
