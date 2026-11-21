# FreeRTC relay on an ESP32-C6

A FreeRTC relay for a small device: the Seeed Studio IoT Button, or any ESP32-C6 board. It speaks PSP
as `src/index.js` does, without federation: peers on it find each other in a Network and Room
(`announce`, `discover`, `peer_list`) and pass their negotiation messages through it (`offer`,
`answer`, `ice_candidate`, ...), held briefly for a peer that is away. Signaling only.

- `core/`: the relay, in C, with no platform code (`relay.h` says how a platform drives it).
- `linux/`: the core behind a small WebSocket server, for testing: `make && ./freertc-c6-relay 8790`.
- `firmware/`: the ESP-IDF project for the C6.
- `third_party/cjson`: cJSON (MIT), the JSON parser.

## What it does not do (yet)

- **Federation.** Peers on it meet only peers on it.
- **wss://.** It serves `ws://<address>/ws`. Pages on https sites can't open `ws://`, so browsers need a
  name and a certificate first; programs (Node peers, wurl, PigeonAI's server) can use it now.

## Flash it

From Chrome or Edge, no install: open https://espressif.github.io/esptool-js/, plug the button in by
USB-C, Connect, choose `freertc-c6-relay-full.bin` at address `0x0`, Program. This replaces the
button's own firmware.

Or with esptool: `esptool.py --chip esp32c6 write_flash 0x0 freertc-c6-relay-full.bin`.

## First boot

It opens the Wi-Fi network `FreeRTC-Relay-XXXX`. Join it, open http://192.168.4.1, and enter your
Wi-Fi's name and password. It restarts onto your network as `freertc-relay`; http://<its address>/
shows its counts and its `ws://` address. If it can't join your Wi-Fi for a minute (a new password,
another place), the setup network opens again while it keeps trying.

It stays on: no sleep, no Wi-Fi power save. Keep it on USB power.

## Build

```
idf.py set-target esp32c6 && idf.py build
```

ESP-IDF 5.4. Limits on the C6 (`firmware/main/CMakeLists.txt`): 16 connections, 24 announcements,
messages up to 16 KB, 32 KB held for peers that are away.
