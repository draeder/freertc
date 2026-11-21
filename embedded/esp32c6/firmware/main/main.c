/*
 * FreeRTC relay on an ESP32-C6 (the Seeed IoT Button, or any C6): the relay core (../../core) behind
 * ESP-IDF's HTTP server, on the local network.
 *
 * First boot (no Wi-Fi saved): it opens the Wi-Fi network "FreeRTC-Relay-XXXX"; join it and open
 * http://192.168.4.1 to give it your Wi-Fi's name and password. They are kept in flash (NVS), and it
 * restarts onto your network.
 *
 * Then: ws://<its address>/ws is the relay, http://<its address>/ shows its counts. It stays on (no
 * sleep, no Wi-Fi power save): run it on USB power.
 *
 * Everything the relay core does runs on the HTTP server's one task (frames, closes, and the tick, queued
 * onto it), so the core needs no locks.
 */
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "lwip/sockets.h"

#include "driver/gpio.h"
#include "relay.h"

static const char *TAG = "freertc";
static volatile int mode; /* 0 starting, 1 setup network open, 2 joining Wi-Fi, 3 relay running */
static char setup_ssid[33] = "";
static char heard[160] = "not scanned";   /* what the scan at setup heard, repeated in the status line */
static volatile bool ap_on;
static volatile bool station;   /* joining a saved network (not the setup scan) */
static httpd_handle_t server;
static int conn_fd[RELAY_MAX_CONNS];   /* connection index -> socket, -1 free */
static char ip_text[16] = "";

/* ---------------- the core's platform ---------------- */

static int64_t p_now(void *ctx) { struct timeval tv; gettimeofday(&tv, NULL); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }
static void p_random(void *ctx, uint8_t *out, size_t n) { esp_fill_random(out, n); }
static void p_log(void *ctx, const char *line) { ESP_LOGI(TAG, "%s", line); }
static int p_send(void *ctx, int conn, const char *data, size_t len) {
  if (conn < 0 || conn >= RELAY_MAX_CONNS || conn_fd[conn] < 0) return -1;
  httpd_ws_frame_t f = { .final = true, .type = HTTPD_WS_TYPE_TEXT, .payload = (uint8_t *)data, .len = len };
  return httpd_ws_send_frame_async(server, conn_fd[conn], &f) == ESP_OK ? 0 : -1;
}
static void p_close(void *ctx, int conn, int code, const char *reason) {
  if (conn < 0 || conn >= RELAY_MAX_CONNS || conn_fd[conn] < 0) return;
  uint8_t b[125]; size_t n = strlen(reason); if (n > 120) n = 120;
  b[0] = code >> 8; b[1] = code & 0xff; memcpy(b + 2, reason, n);
  httpd_ws_frame_t f = { .final = true, .type = HTTPD_WS_TYPE_CLOSE, .payload = b, .len = n + 2 };
  httpd_ws_send_frame_async(server, conn_fd[conn], &f);
  httpd_sess_trigger_close(server, conn_fd[conn]);
}

static int conn_of(int fd) { for (int i = 0; i < RELAY_MAX_CONNS; i++) if (conn_fd[i] == fd) return i; return -1; }

/* ---------------- the relay's HTTP handlers ---------------- */

static esp_err_t ws_handler(httpd_req_t *req) {
  int fd = httpd_req_to_sockfd(req);
  if (req->method == HTTP_GET) {
    /* The upgrade: a connection for the core, if there is room. */
    int slot = -1;
    for (int i = 0; i < RELAY_MAX_CONNS; i++) if (conn_fd[i] < 0) { slot = i; break; }
    if (slot < 0 || relay_opened(slot) != 0) return ESP_FAIL;
    conn_fd[slot] = fd;
    return ESP_OK;
  }
  httpd_ws_frame_t f = { 0 };
  if (httpd_ws_recv_frame(req, &f, 0) != ESP_OK) return ESP_FAIL;
  int conn = conn_of(fd);
  if (conn < 0 || f.len > RELAY_MAX_MESSAGE) return ESP_FAIL;
  char *buf = malloc(f.len + 1);
  if (!buf) return ESP_FAIL;
  f.payload = (uint8_t *)buf;
  if (httpd_ws_recv_frame(req, &f, f.len) != ESP_OK) { free(buf); return ESP_FAIL; }
  buf[f.len] = 0;
  if (f.type == HTTPD_WS_TYPE_TEXT) relay_message(conn, buf, f.len); /* PSP is text; anything else is read and let go */
  free(buf);
  return ESP_OK;
}

static esp_err_t status_handler(httpd_req_t *req) {
  relay_stats s = relay_get_stats();
  char body[360];
  snprintf(body, sizeof body,
    "{\"ok\":true,\"relay\":\"%s\",\"ws\":\"ws://%s/ws\",\"conns\":%d,\"peers\":%d,\"held\":%d,\"delivered\":%lu,\"dropped\":%lu,\"free_heap\":%lu}\n",
    relay_peer_id(), ip_text, s.conns, s.peers, s.queued, (unsigned long)s.delivered, (unsigned long)s.dropped, (unsigned long)esp_get_free_heap_size());
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_sendstr(req, body);
}

/* A socket closed: its connection leaves the core. */
static void on_close(httpd_handle_t hd, int fd) {
  int conn = conn_of(fd);
  if (conn >= 0) { relay_closed(conn); conn_fd[conn] = -1; }
  close(fd);
}

static void tick_work(void *arg) { relay_tick(); }
static void tick_timer(void *arg) { if (server) httpd_queue_work(server, tick_work, NULL); }

static void start_relay(void) {
  for (int i = 0; i < RELAY_MAX_CONNS; i++) conn_fd[i] = -1;
  relay_platform pf = { p_now, p_random, p_send, p_close, p_log, NULL };
  relay_init(&pf, NULL);

  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.max_open_sockets = RELAY_MAX_CONNS + 2;
  cfg.lru_purge_enable = false;
  cfg.close_fn = on_close;
  cfg.stack_size = 8192;
  ESP_ERROR_CHECK(httpd_start(&server, &cfg));
  httpd_uri_t ws = { .uri = "/ws", .method = HTTP_GET, .handler = ws_handler, .is_websocket = true, .handle_ws_control_frames = false };
  httpd_uri_t st = { .uri = "/", .method = HTTP_GET, .handler = status_handler };
  httpd_register_uri_handler(server, &ws);
  httpd_register_uri_handler(server, &st);

  const esp_timer_create_args_t t = { .callback = tick_timer, .name = "relay_tick" };
  esp_timer_handle_t timer;
  esp_timer_create(&t, &timer);
  esp_timer_start_periodic(timer, 1000 * 1000);
  mode = 3;
  ESP_LOGI(TAG, "Relay at ws://%s/ws", ip_text);
}

/* ---------------- Wi-Fi ---------------- */

static EventGroupHandle_t wifi_events;
#define GOT_IP BIT0

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) ESP_LOGI(TAG, "A device joined the setup network");
  else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STADISCONNECTED) ESP_LOGW(TAG, "A device left the setup network (reason %d)", ((wifi_event_ap_stadisconnected_t *)data)->reason);
  else if (base == IP_EVENT && id == IP_EVENT_AP_STAIPASSIGNED) ESP_LOGI(TAG, "The setup network gave a device an address: open http://192.168.4.1");
  else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) { if (station) esp_wifi_connect(); }
  else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED && station) {
    wifi_event_sta_disconnected_t *e = data;
    /* 15 or 204: wrong password; 201: that network isn't heard */
    ESP_LOGW(TAG, "Not joined (reason %d%s)", e->reason, e->reason == 15 || e->reason == 204 ? ": wrong password?" : e->reason == 201 ? ": network not heard" : "");
    esp_wifi_connect();
  }
  else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_START) { ap_on = true; ESP_LOGI(TAG, "Setup network is on the air"); }
  else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = data;
    snprintf(ip_text, sizeof ip_text, IPSTR, IP2STR(&e->ip_info.ip));
    ESP_LOGI(TAG, "On the network as %s", ip_text);
    xEventGroupSetBits(wifi_events, GOT_IP);
  }
}

static bool saved_wifi(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap) {
  nvs_handle_t h;
  if (nvs_open("wifi", NVS_READONLY, &h) != ESP_OK) return false;
  bool ok = nvs_get_str(h, "ssid", ssid, &ssid_cap) == ESP_OK && nvs_get_str(h, "pass", pass, &pass_cap) == ESP_OK && ssid[0];
  nvs_close(h);
  return ok;
}

/* ---------------- first-boot setup (its own Wi-Fi network and a form) ---------------- */

static const char SETUP_PAGE[] =
  "<!doctype html><meta name=viewport content='width=device-width'><title>FreeRTC relay</title>"
  "<body style='font:16px system-ui;max-width:420px;margin:2em auto;padding:0 1em'>"
  "<h2>FreeRTC relay</h2><p>Which Wi-Fi should it join?</p>"
  "<form method=post action=/save><p><input name=ssid placeholder='Wi-Fi name' required style='width:100%;padding:.5em'>"
  "<p><input name=pass type=password placeholder='Password' style='width:100%;padding:.5em'>"
  "<p><button style='padding:.6em 1.2em'>Save and restart</button></form>";

static esp_err_t setup_page(httpd_req_t *req) { httpd_resp_set_type(req, "text/html"); return httpd_resp_sendstr(req, SETUP_PAGE); }

/* A form field, URL-decoded. */
static void field(const char *body, const char *name, char *out, size_t cap) {
  out[0] = 0;
  size_t nl = strlen(name);
  for (const char *p = body; p && *p; p = strchr(p, '&') ? strchr(p, '&') + 1 : NULL) {
    if (strncmp(p, name, nl) || p[nl] != '=') continue;
    p += nl + 1;
    size_t o = 0;
    while (*p && *p != '&' && o + 1 < cap) {
      if (*p == '+') { out[o++] = ' '; p++; }
      else if (*p == '%' && p[1] && p[2]) { char hx[3] = { p[1], p[2], 0 }; out[o++] = (char)strtol(hx, NULL, 16); p += 3; }
      else out[o++] = *p++;
    }
    out[o] = 0;
    return;
  }
}

static esp_err_t setup_save(httpd_req_t *req) {
  char body[256] = { 0 };
  int n = httpd_req_recv(req, body, sizeof body - 1);
  if (n <= 0) return ESP_FAIL;
  char ssid[33], pass[65];
  field(body, "ssid", ssid, sizeof ssid); field(body, "pass", pass, sizeof pass);
  if (!ssid[0]) return httpd_resp_sendstr(req, "A Wi-Fi name is needed.");
  nvs_handle_t h;
  ESP_ERROR_CHECK(nvs_open("wifi", NVS_READWRITE, &h));
  nvs_set_str(h, "ssid", ssid); nvs_set_str(h, "pass", pass); nvs_commit(h); nvs_close(h);
  httpd_resp_set_type(req, "text/html");
  httpd_resp_sendstr(req, "<body style='font:16px system-ui;margin:2em'>Saved. It restarts onto your Wi-Fi now; this network goes away.");
  vTaskDelay(pdMS_TO_TICKS(1500));
  esp_restart();
  return ESP_OK;
}

/* Its own Wi-Fi network and the form. `also_station`: Wi-Fi is already started, trying the saved network
 * (which it keeps trying). */
/* Seeed's C6 boards switch the radio to an antenna: GPIO3 low powers the switch, GPIO14 picks the
 * antenna (low: the one on the board, high: the external connector). */
static int antenna = 0;
static void set_antenna(int external) {
  gpio_config_t io = { .pin_bit_mask = (1ULL << GPIO_NUM_3) | (1ULL << GPIO_NUM_14), .mode = GPIO_MODE_OUTPUT };
  gpio_config(&io);
  gpio_set_level(GPIO_NUM_3, 0);
  gpio_set_level(GPIO_NUM_14, external);
  antenna = external;
  vTaskDelay(pdMS_TO_TICKS(100));
}

static int scan_count(void) {
  wifi_scan_config_t sc = { .show_hidden = false };
  if (esp_wifi_scan_start(&sc, true) != ESP_OK) return -1;
  uint16_t n = 0; esp_wifi_scan_get_ap_num(&n);
  esp_wifi_clear_ap_list();
  return n;
}

/* The networks it hears, strongest first: shows its radio works (and what it can join). */
static void scan_and_print(void) {
  /* Which antenna hears more: kept for the rest of the run, and saved. */
  set_antenna(0); int a = scan_count();
  set_antenna(1); int b = scan_count();
  set_antenna(b > a ? 1 : 0);
  nvs_handle_t h;
  if (nvs_open("wifi", NVS_READWRITE, &h) == ESP_OK) { nvs_set_u8(h, "ant", antenna); nvs_commit(h); nvs_close(h); }
  char note[64]; snprintf(note, sizeof note, "board antenna %d, external %d; ", a, b);
  wifi_scan_config_t sc = { .show_hidden = false };
  if (esp_wifi_scan_start(&sc, true) != ESP_OK) { ESP_LOGW(TAG, "Wi-Fi scan failed"); return; }
  uint16_t n = 20; wifi_ap_record_t recs[20];
  esp_wifi_scan_get_ap_records(&n, recs);
  ESP_LOGI(TAG, "It hears %d Wi-Fi networks:", n);
  int len = snprintf(heard, sizeof heard, "%s%d networks", note, n);
  for (int i = 0; i < n && i < 3 && len < (int)sizeof heard - 1; i++)
    len += snprintf(heard + len, sizeof heard - len, "%s %s %d dBm", i ? "," : ":", (char *)recs[i].ssid, recs[i].rssi);
  for (int i = 0; i < n; i++) ESP_LOGI(TAG, "  %-32s signal %d dBm, channel %d", (char *)recs[i].ssid, recs[i].rssi, recs[i].primary);
}

static void run_setup(bool also_station) {
  esp_netif_create_default_wifi_ap();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL, NULL);
  esp_event_handler_instance_register(IP_EVENT, IP_EVENT_AP_STAIPASSIGNED, wifi_event, NULL, NULL);
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_start());
  scan_and_print();
  ESP_ERROR_CHECK(esp_wifi_stop());
  uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  wifi_config_t ap = { .ap = { .channel = 6, .max_connection = 4, .authmode = WIFI_AUTH_OPEN, .pmf_cfg = { .required = false, .capable = false } } };
  int n = snprintf((char *)ap.ap.ssid, sizeof ap.ap.ssid, "FreeRTC-Relay-%02X%02X", mac[4], mac[5]);
  ap.ap.ssid_len = n;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
  /* 802.11b/g/n only: Macs fail to join the C6's Wi-Fi 6 (ax) access point. */
  esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
  ESP_ERROR_CHECK(esp_wifi_start());
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  ESP_ERROR_CHECK(httpd_start(&server, &cfg));
  httpd_uri_t page = { .uri = "/", .method = HTTP_GET, .handler = setup_page };
  httpd_uri_t save = { .uri = "/save", .method = HTTP_POST, .handler = setup_save };
  httpd_register_uri_handler(server, &page);
  httpd_register_uri_handler(server, &save);
  snprintf(setup_ssid, sizeof setup_ssid, "%s", (char *)ap.ap.ssid);
  mode = 1;
  ESP_LOGI(TAG, "Setup: join Wi-Fi \"%s\" and open http://192.168.4.1", ap.ap.ssid);
}

/* A line every 5 s on the USB log. */
static void status_task(void *arg) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(5000));
    if (mode == 1) ESP_LOGI(TAG, "Setup network \"%s\" %s. It heard %s", setup_ssid, ap_on ? "is on the air" : "did NOT start", heard);
    else if (mode == 2) ESP_LOGI(TAG, "Joining Wi-Fi…");
    else if (mode == 3) { relay_stats s = relay_get_stats(); ESP_LOGI(TAG, "Relay ws://%s/ws: %d connections, %d peers, free memory %lu", ip_text, s.conns, s.peers, (unsigned long)esp_get_free_heap_size()); }
  }
}

void app_main(void) {
  xTaskCreate(status_task, "status", 3072, NULL, 1, NULL);
  ESP_LOGI(TAG, "FreeRTC relay starting");
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); err = nvs_flash_init(); }
  ESP_ERROR_CHECK(err);
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());

  char ssid[33], pass[65];
  /* No Wi-Fi saved, or the saved one failed last time (setup asked for): the setup network. */
  bool want_setup = false;
  nvs_handle_t h;
  if (nvs_open("wifi", NVS_READWRITE, &h) == ESP_OK) {
    uint8_t flag = 0;
    if (nvs_get_u8(h, "setup", &flag) == ESP_OK && flag) { want_setup = true; nvs_erase_key(h, "setup"); nvs_commit(h); }
    nvs_close(h);
  }
  if (want_setup || !saved_wifi(ssid, sizeof ssid, pass, sizeof pass)) { run_setup(false); return; }

  mode = 2;
  station = true;
  wifi_events = xEventGroupCreate();
  esp_netif_t *sta = esp_netif_create_default_wifi_sta();
  esp_netif_set_hostname(sta, "freertc-relay");
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL, NULL);
  esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL, NULL);
  {
    uint8_t ant = 0; nvs_handle_t ah;
    if (nvs_open("wifi", NVS_READONLY, &ah) == ESP_OK) { nvs_get_u8(ah, "ant", &ant); nvs_close(ah); }
    set_antenna(ant);
  }
  ESP_LOGI(TAG, "Joining \"%s\"", ssid);
  wifi_config_t sc = { 0 };
  /* Wi-Fi names and passwords fill these fields whole (32 and 64 bytes) with no terminator needed. */
  memcpy(sc.sta.ssid, ssid, strnlen(ssid, sizeof sc.sta.ssid));
  memcpy(sc.sta.password, pass, strnlen(pass, sizeof sc.sta.password));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sc));
  ESP_ERROR_CHECK(esp_wifi_start());
  esp_wifi_set_ps(WIFI_PS_NONE);   /* a relay answers at once: no Wi-Fi power save */
  /* Not on the saved network within two minutes (a new password, another place): it restarts into the
   * setup network once (the saved network is kept; the next restart tries it again). */
  if (!(xEventGroupWaitBits(wifi_events, GOT_IP, false, true, pdMS_TO_TICKS(120000)) & GOT_IP)) {
    ESP_LOGW(TAG, "Can't join \"%s\": restarting into the setup network", ssid);
    if (nvs_open("wifi", NVS_READWRITE, &h) == ESP_OK) { nvs_set_u8(h, "setup", 1); nvs_commit(h); nvs_close(h); }
    esp_restart();
  }

  /* PSP timestamps are wall-clock time. */
  esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  esp_netif_sntp_init(&sntp);
  esp_netif_sntp_sync_wait(pdMS_TO_TICKS(10000));

  start_relay();
}
