idf_component_register(
  SRCS "main.c" "../../core/relay.c" "../../core/sha256.c" "../../third_party/cjson/cJSON.c"
  INCLUDE_DIRS "." "../../core" "../../third_party/cjson"
  REQUIRES esp_wifi esp_http_server esp_netif esp_event nvs_flash esp_timer esp_driver_usb_serial_jtag)
# The C6's memory: 16 connections, messages up to 16 KB, 32 KB held for peers that are away.
target_compile_definitions(${COMPONENT_LIB} PRIVATE RELAY_MAX_CONNS=16 RELAY_MAX_PEERS=24 RELAY_MAX_MESSAGE=16384 RELAY_QUEUE_BYTES=32768 RELAY_QUEUE_COUNT=32)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-unused-parameter)
