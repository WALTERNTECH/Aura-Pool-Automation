// Aura Pool table controller, ESP32 (Arduino framework).
//
// One device per table. It drives a 12 V linear actuator through a two-channel relay board
// whose inputs are joined on one pin and whose contacts are cross-wired, so switching the relay
// reverses the actuator. Relay off: the actuator holds the ball-release slide out and the gate
// stays shut. A signed unlock from the server switches the relay on for the command's duration
// (never more than 60 s): the actuator pulls the slide in, the gate lifts and the balls roll out.
// Relay off again: it pushes the slide back out, and no new unlock is taken until it's back.
// The override button does a local unlock and reports it. Nothing else switches the relay.
//
// Network: the t-a7670e build (LilyGO T-A7670E) connects through its A7670 4G modem and a data
// SIM, so the venue needs no Wi-Fi; it can use Wi-Fi instead if set to. The esp32dev build is
// Wi-Fi only.
//
// Protocol (see api/src/devices/protocol.ts):
//   subscribe pool/{table}/cmd     {cmd_id, action:"unlock", duration_s, issued_at, expires_at, nonce, sig}
//   publish   pool/{table}/ack     {cmd_id, result: ok|rejected|busy, reason, ts}
//   publish   pool/{table}/status  heartbeat every 30 s, retained; last will {"online":false}
//   publish   pool/{table}/event   {type:"manual_override", ts, duration_s}
//   sig = hex(HMAC-SHA256(secret, "cmd_id|action|duration_s|issued_at|expires_at|nonce"))
//
// Setup: first boot (or holding the button for 10 s while powering on) opens a Wi-Fi access
// point "AuraPool-Setup". Join it, open Setup and paste the device id, password, HMAC secret and
// MQTT URL the console showed when the table was provisioned, and the table id. On the 4G build,
// also choose the connection (4g or wifi) and enter the SIM's APN. For Wi-Fi, pick the venue's
// network under Configure WiFi as well.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <esp_task_wdt.h>
#include <esp_idf_version.h>
#include <mbedtls/md.h>
#include <mqtt_client.h>
#include <time.h>
#if __has_include(<esp_crt_bundle.h>)
#include <esp_crt_bundle.h>
#define AURA_HAS_BUNDLE 1
#endif
#ifdef AURA_4G
#include <PPP.h>
#endif

#ifndef AURA_FW_VERSION
#define AURA_FW_VERSION "1.1.0"
#endif
#ifndef AURA_RELAY_PIN
#define AURA_RELAY_PIN 26
#endif
#ifndef AURA_BUTTON_PIN
#define AURA_BUTTON_PIN 27
#endif

// ---------------------------------------------------------------- hardware
static const int RELAY_PIN = AURA_RELAY_PIN;    // relay board IN1 and IN2, joined
static const int BUTTON_PIN = AURA_BUTTON_PIN;  // override button, to ground, internal pull-up
static const uint32_t MAX_ON_MS = 60000;
static const uint32_t DEBOUNCE_MS = 50;
static const uint32_t HEARTBEAT_MS = 30000;
static const uint32_t WDT_TIMEOUT_MS = 15000;
static const uint32_t PORTAL_MS = 300000;          // the setup portal gives up after 5 minutes
static const uint32_t NET_DOWN_REBOOT_MS = 300000; // no network for 5 minutes: reboot, once the table is idle
static const int COMMAND_TTL_S = 60;

#ifdef AURA_4G
// LilyGO T-A7670E. The modem owns these pins; IO21 and IO22 are the free ones.
static const int MODEM_TX = 26, MODEM_RX = 27, MODEM_PWRKEY = 4, MODEM_RESET = 5, MODEM_DTR = 25, BOARD_POWERON = 12;
static const int MODEM_RESET_LEVEL = HIGH;
#endif

// ---------------------------------------------------------------- configuration (NVS)
struct Config {
  String deviceId, password, secret, mqttUrl, tableId;
  bool activeLow = true;            // most relay boards switch on a LOW input
  uint32_t overrideSeconds = 20;    // updated from the last command's duration
  uint32_t returnSeconds = 8;       // how long the actuator takes to travel; it's back out after this
#ifdef AURA_4G
  String link = "4g";               // "4g" or "wifi"
  String apn = "safaricom";
  bool cmux = true;                 // modem in CMUX mode (signal readings while online); falls back to plain data mode
#endif
} cfg;

Preferences prefs;

static void loadConfig() {
  prefs.begin("aura", true);
  cfg.deviceId = prefs.getString("device", "");
  cfg.password = prefs.getString("password", "");
  cfg.secret = prefs.getString("secret", "");
  cfg.mqttUrl = prefs.getString("mqtt", "");
  cfg.tableId = prefs.getString("table", "");
  cfg.activeLow = prefs.getBool("activeLow", true);
  cfg.overrideSeconds = prefs.getUInt("ovr", 20);
  cfg.returnSeconds = prefs.getUInt("ret", 8);
#ifdef AURA_4G
  cfg.link = prefs.getString("link", "4g");
  cfg.apn = prefs.getString("apn", "safaricom");
  cfg.cmux = prefs.getBool("cmux", true);
#endif
  prefs.end();
}

static void saveConfig() {
  prefs.begin("aura", false);
  prefs.putString("device", cfg.deviceId);
  prefs.putString("password", cfg.password);
  prefs.putString("secret", cfg.secret);
  prefs.putString("mqtt", cfg.mqttUrl);
  prefs.putString("table", cfg.tableId);
  prefs.putBool("activeLow", cfg.activeLow);
  prefs.putUInt("ovr", cfg.overrideSeconds);
  prefs.putUInt("ret", cfg.returnSeconds);
#ifdef AURA_4G
  prefs.putString("link", cfg.link);
  prefs.putString("apn", cfg.apn);
  prefs.putBool("cmux", cfg.cmux);
#endif
  prefs.end();
}

static bool configured() {
  return cfg.deviceId.length() && cfg.password.length() && cfg.secret.length() && cfg.mqttUrl.length() && cfg.tableId.length();
}

static bool useCell() {
#ifdef AURA_4G
  return cfg.link != "wifi";
#else
  return false;
#endif
}

static void setWatchdog(uint32_t ms) {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t w = {.timeout_ms = ms, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&w);
#else
  esp_task_wdt_init(ms / 1000, true);
#endif
}

// ---------------------------------------------------------------- relay and actuator
static volatile bool relayOn = false;
static uint32_t relayOffAt = 0;
static uint32_t settleAt = 0;  // the actuator is on its way back out until then

static void relayWrite(bool on) {
  digitalWrite(RELAY_PIN, (on ^ cfg.activeLow) ? HIGH : LOW);
  relayOn = on;
}

// Relay off and the actuator back in its resting place: ready for the next unlock.
static bool idle() { return !relayOn && (int32_t)(millis() - settleAt) >= 0; }

static void relayRun(uint32_t seconds) {
  uint32_t ms = seconds * 1000UL;
  uint32_t least = (cfg.returnSeconds + 2) * 1000UL;  // the full stroke in, and a moment for the balls
  if (ms < least) ms = least;
  if (ms > MAX_ON_MS) ms = MAX_ON_MS;  // hard cap, whatever the command says
  relayOffAt = millis() + ms;
  relayWrite(true);
}

static void relayRelease() {
  relayWrite(false);
  settleAt = millis() + cfg.returnSeconds * 1000UL;
}

// ---------------------------------------------------------------- network (4G or Wi-Fi)
static int cellDbm = 0;  // signal at the last reading; 0 = unknown

#ifdef AURA_4G
enum CellState { CELL_OFF, CELL_REGISTERING, CELL_DIALING, CELL_ONLINE };
static CellState cell = CELL_OFF;
static uint32_t cellSince = 0, cellPolled = 0;

static int csqToDbm(int csq) { return csq >= 0 && csq <= 31 ? -113 + 2 * csq : 0; }

// Power the modem up the way LilyGO's examples do, then wait for it to answer AT.
static bool modemPowerOn() {
  pinMode(BOARD_POWERON, OUTPUT);
  digitalWrite(BOARD_POWERON, HIGH);
  pinMode(MODEM_DTR, OUTPUT);
  digitalWrite(MODEM_DTR, LOW);  // held low: a DTR change can end the data call
  pinMode(MODEM_RESET, OUTPUT);
  digitalWrite(MODEM_RESET, !MODEM_RESET_LEVEL);
  delay(100);
  digitalWrite(MODEM_RESET, MODEM_RESET_LEVEL);
  delay(2600);
  digitalWrite(MODEM_RESET, !MODEM_RESET_LEVEL);
  pinMode(MODEM_PWRKEY, OUTPUT);
  digitalWrite(MODEM_PWRKEY, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY, HIGH);
  delay(100);
  digitalWrite(MODEM_PWRKEY, LOW);

  Serial1.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
  bool ok = false;
  for (uint32_t t0 = millis(); !ok && millis() - t0 < 30000;) {
    esp_task_wdt_reset();
    while (Serial1.available()) Serial1.read();
    Serial1.print("AT\r");
    String reply;
    for (uint32_t t1 = millis(); millis() - t1 < 500;) {
      while (Serial1.available()) reply += (char)Serial1.read();
      if (reply.indexOf("OK") >= 0) { ok = true; break; }
      delay(10);
    }
  }
  Serial1.end();
  return ok;
}

static void cellStart() {
  setWatchdog(120000);  // bringing the modem up blocks for a while
  bool ok = modemPowerOn();
  if (ok) {
    PPP.setApn(cfg.apn.c_str());
    PPP.setPins(MODEM_TX, MODEM_RX);
    ok = PPP.begin(PPP_MODEM_GENERIC);
  }
  setWatchdog(WDT_TIMEOUT_MS);
  esp_task_wdt_reset();
  Serial.printf("modem %s\n", ok ? "ready, registering" : "not answering");
  cell = ok ? CELL_REGISTERING : CELL_OFF;  // not answering: the network-down reboot tries again
  cellSince = millis();
}

// Registration, then the data call. A data call that never gets an address switches between
// CMUX and plain data mode for the next boot.
static void cellLoop() {
  uint32_t now = millis();
  switch (cell) {
    case CELL_REGISTERING:
      if (now - cellPolled < 2000) break;
      cellPolled = now;
      if (PPP.attached()) {
        cellDbm = csqToDbm(PPP.RSSI());
        Serial.printf("registered on %s, %d dBm\n", PPP.operatorName().c_str(), cellDbm);
        PPP.mode(cfg.cmux ? ESP_MODEM_MODE_CMUX : ESP_MODEM_MODE_DATA);
        cell = CELL_DIALING;
        cellSince = now;
      }
      break;
    case CELL_DIALING:
      if (PPP.connected() && PPP.hasIP()) {
        Serial.printf("online over 4G, %s\n", PPP.localIP().toString().c_str());
        cell = CELL_ONLINE;
        cellPolled = now;
      } else if (now - cellSince > 60000 && idle()) {
        cfg.cmux = !cfg.cmux;
        prefs.begin("aura", false);
        prefs.putBool("cmux", cfg.cmux);
        prefs.end();
        ESP.restart();
      }
      break;
    case CELL_ONLINE:
      // In CMUX mode the modem still answers AT commands, so the signal can be read now and then.
      if (cfg.cmux && now - cellPolled > 300000) {
        cellPolled = now;
        int dbm = csqToDbm(PPP.RSSI());
        if (dbm) cellDbm = dbm;
      }
      break;
    default:
      break;
  }
}
#endif

static bool netUp() {
#ifdef AURA_4G
  if (useCell()) return PPP.connected() && PPP.hasIP();
#endif
  return WiFi.status() == WL_CONNECTED;
}

static int netRssi() { return useCell() ? cellDbm : WiFi.RSSI(); }

static String netIp() {
#ifdef AURA_4G
  if (useCell()) return PPP.localIP().toString();
#endif
  return WiFi.localIP().toString();
}

// ---------------------------------------------------------------- MQTT
static esp_mqtt_client_handle_t mqtt = nullptr;
static bool mqttUp = false;
static uint32_t backoffMs = 1000;
static uint32_t reconnectAt = 0;
static String tCmd, tAck, tStatus, tEvent;
static const char *WILL = "{\"online\":false}";

static String recent[50];
static int recentNext = 0;

static bool seen(const String &id) {
  for (auto &r : recent) if (r == id) return true;
  return false;
}
static void remember(const String &id) {
  recent[recentNext] = id;
  recentNext = (recentNext + 1) % 50;
}

static bool timeReady() { return time(nullptr) > 1700000000; }
static long nowS() { return (long)time(nullptr); }

static void publish(const String &topic, const String &payload, int qos, bool retain) {
  if (mqtt && mqttUp) esp_mqtt_client_publish(mqtt, topic.c_str(), payload.c_str(), payload.length(), qos, retain ? 1 : 0);
}

static void sendStatus() {
  JsonDocument d;
  d["online"] = true;
  d["fw"] = AURA_FW_VERSION;
  d["link"] = useCell() ? "4g" : "wifi";
  int rssi = netRssi();
  if (rssi) d["rssi"] = rssi;
  d["uptime_s"] = millis() / 1000;
  d["relay"] = relayOn ? "on" : "off";
  d["ip"] = netIp();
  d["ts"] = nowS();
  String s;
  serializeJson(d, s);
  publish(tStatus, s, 1, true);
}

static void sendAck(const String &cmdId, const char *result, const char *reason) {
  JsonDocument d;
  d["cmd_id"] = cmdId;
  d["result"] = result;
  if (reason) d["reason"] = reason;
  d["ts"] = nowS();
  String s;
  serializeJson(d, s);
  publish(tAck, s, 1, false);
}

static void sendEvent(const char *type, uint32_t durationS) {
  JsonDocument d;
  d["type"] = type;
  d["ts"] = nowS();
  d["duration_s"] = durationS;
  String s;
  serializeJson(d, s);
  publish(tEvent, s, 1, false);
}

static String hmacHex(const String &key, const String &msg) {
  uint8_t out[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char *)key.c_str(), key.length());
  mbedtls_md_hmac_update(&ctx, (const unsigned char *)msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  static const char *hex = "0123456789abcdef";
  String s;
  s.reserve(64);
  for (int i = 0; i < 32; i++) {
    s += hex[out[i] >> 4];
    s += hex[out[i] & 15];
  }
  return s;
}

static bool sameHex(const String &a, const String &b) {
  if (a.length() != b.length()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) diff |= (uint8_t)(tolower(a[i]) ^ tolower(b[i]));
  return diff == 0;
}

static void onCommand(const char *data, int len) {
  JsonDocument d;
  if (deserializeJson(d, data, len)) return;  // not JSON: ignore
  String cmdId = d["cmd_id"] | "";
  String action = d["action"] | "";
  long duration = d["duration_s"] | -1L;
  long issued = d["issued_at"] | -1L;
  long expires = d["expires_at"] | -1L;
  String nonce = d["nonce"] | "";
  String sig = d["sig"] | "";
  if (!cmdId.length() || action != "unlock" || duration < 1 || issued < 0 || expires < 0 || !nonce.length() || sig.length() != 64) {
    sendAck(cmdId, "rejected", "malformed");
    return;
  }
  String canonical = cmdId + "|" + action + "|" + String(duration) + "|" + String(issued) + "|" + String(expires) + "|" + nonce;
  if (!sameHex(hmacHex(cfg.secret, canonical), sig)) {
    sendAck(cmdId, "rejected", "bad_signature");
    return;
  }
  if (!timeReady()) {
    sendAck(cmdId, "rejected", "no_time");
    return;
  }
  long now = nowS();
  if (now > expires || now - issued > COMMAND_TTL_S) {
    sendAck(cmdId, "rejected", "expired");
    return;
  }
  if (seen(cmdId)) {
    // Already ran it (the server resent after a lost ack): say so; the server counts it as delivered.
    sendAck(cmdId, "rejected", "duplicate");
    return;
  }
  if (!idle()) {
    // Still holding the last game's slide in, or the actuator is still on its way back: the server retries.
    sendAck(cmdId, "busy", relayOn ? "relay_on" : "returning");
    return;
  }
  remember(cmdId);
  relayRun((uint32_t)duration);
  if ((uint32_t)duration != cfg.overrideSeconds && duration <= 60) {
    cfg.overrideSeconds = (uint32_t)duration;
    prefs.begin("aura", false);
    prefs.putUInt("ovr", cfg.overrideSeconds);
    prefs.end();
  }
  sendAck(cmdId, "ok", nullptr);
  sendStatus();
}

static void mqttEvent(void *, esp_event_base_t, int32_t eventId, void *eventData) {
  auto *e = (esp_mqtt_event_handle_t)eventData;
  switch ((esp_mqtt_event_id_t)eventId) {
    case MQTT_EVENT_CONNECTED:
      mqttUp = true;
      backoffMs = 1000;
      esp_mqtt_client_subscribe(mqtt, tCmd.c_str(), 1);
      sendStatus();
      sendEvent("boot", 0);
      break;
    case MQTT_EVENT_DISCONNECTED:
      mqttUp = false;
      reconnectAt = millis() + backoffMs;
      backoffMs = backoffMs * 2 > 60000 ? 60000 : backoffMs * 2;  // 1 s, 2 s, 4 s … 60 s
      break;
    case MQTT_EVENT_DATA:
      // Commands are small; a chunked message would arrive with current_data_offset > 0 and is ignored.
      if (e->current_data_offset == 0 && e->total_data_len == e->data_len && e->topic_len == (int)tCmd.length() && strncmp(e->topic, tCmd.c_str(), e->topic_len) == 0) {
        onCommand(e->data, e->data_len);
      }
      break;
    default:
      break;
  }
}

static void startMqtt() {
  tCmd = "pool/" + cfg.tableId + "/cmd";
  tAck = "pool/" + cfg.tableId + "/ack";
  tStatus = "pool/" + cfg.tableId + "/status";
  tEvent = "pool/" + cfg.tableId + "/event";
  esp_mqtt_client_config_t c = {};
#if ESP_IDF_VERSION_MAJOR >= 5
  c.broker.address.uri = cfg.mqttUrl.c_str();
#ifdef AURA_HAS_BUNDLE
  c.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
#endif
  c.credentials.username = cfg.deviceId.c_str();
  c.credentials.client_id = cfg.deviceId.c_str();
  c.credentials.authentication.password = cfg.password.c_str();
  c.session.keepalive = 30;
  c.session.last_will.topic = tStatus.c_str();
  c.session.last_will.msg = WILL;
  c.session.last_will.qos = 1;
  c.session.last_will.retain = 1;
  c.network.disable_auto_reconnect = true;
  c.network.timeout_ms = 10000;
#else
  c.uri = cfg.mqttUrl.c_str();
#ifdef AURA_HAS_BUNDLE
  c.crt_bundle_attach = esp_crt_bundle_attach;
#endif
  c.username = cfg.deviceId.c_str();
  c.client_id = cfg.deviceId.c_str();
  c.password = cfg.password.c_str();
  c.keepalive = 30;
  c.lwt_topic = tStatus.c_str();
  c.lwt_msg = WILL;
  c.lwt_qos = 1;
  c.lwt_retain = 1;
  c.disable_auto_reconnect = true;
  c.network_timeout_ms = 10000;
#endif
  mqtt = esp_mqtt_client_init(&c);
  esp_mqtt_client_register_event(mqtt, (esp_mqtt_event_id_t)ESP_EVENT_ANY_ID, mqttEvent, nullptr);
  esp_mqtt_client_start(mqtt);
}

// ---------------------------------------------------------------- setup portal
// Settings go on the portal's Setup page; Configure WiFi is only needed when the table uses Wi-Fi.
// Returns once the settings are saved and the chosen network can be used, or after 5 minutes.
static void runPortal(bool force) {
  if (!force && configured()) {
    if (useCell()) return;
    WiFi.mode(WIFI_STA);
    WiFi.begin();  // the network saved last time
    for (uint32_t t0 = millis(); WiFi.status() != WL_CONNECTED && millis() - t0 < 20000;) {
      esp_task_wdt_reset();
      delay(100);
    }
    if (WiFi.status() == WL_CONNECTED) return;
  }

  WiFiManager wm;
  char ret[4];
  snprintf(ret, sizeof ret, "%u", (unsigned)cfg.returnSeconds);
  WiFiManagerParameter pDevice("device", "Device ID", cfg.deviceId.c_str(), 16);
  WiFiManagerParameter pPassword("password", "Device password", cfg.password.c_str(), 64);
  WiFiManagerParameter pSecret("secret", "HMAC secret", cfg.secret.c_str(), 96);
  WiFiManagerParameter pUrl("mqtt", "MQTT URL (wss://…/mqtt)", cfg.mqttUrl.c_str(), 160);
  WiFiManagerParameter pTable("table", "Table ID (e.g. T001)", cfg.tableId.c_str(), 8);
  WiFiManagerParameter pLow("activeLow", "Relay active level: LOW=1, HIGH=0", cfg.activeLow ? "1" : "0", 2);
  WiFiManagerParameter pRet("ret", "Actuator travel time, seconds", ret, 3);
#ifdef AURA_4G
  WiFiManagerParameter pLink("link", "Connection: 4g or wifi", cfg.link.c_str(), 5);
  WiFiManagerParameter pApn("apn", "SIM APN (safaricom; internet on Airtel)", cfg.apn.c_str(), 40);
  wm.addParameter(&pLink);
  wm.addParameter(&pApn);
#endif
  wm.addParameter(&pDevice);
  wm.addParameter(&pPassword);
  wm.addParameter(&pSecret);
  wm.addParameter(&pUrl);
  wm.addParameter(&pTable);
  wm.addParameter(&pLow);
  wm.addParameter(&pRet);
  std::vector<const char *> menu = {"param", "wifi", "info", "exit"};
  wm.setMenu(menu);
  wm.setParamsPage(true);
  wm.setConfigPortalBlocking(false);
  wm.setBreakAfterConfig(true);
  bool paramsSaved = false;
  wm.setSaveParamsCallback([&]() { paramsSaved = true; });

  WiFi.mode(WIFI_AP_STA);
  wm.startConfigPortal("AuraPool-Setup");
  bool done = false;
  uint32_t t0 = millis(), doneAt = 0;
  while (millis() - t0 < PORTAL_MS && wm.getConfigPortalActive()) {
    esp_task_wdt_reset();
    wm.process();
    if (paramsSaved) {
      paramsSaved = false;
      cfg.deviceId = pDevice.getValue();
      cfg.password = pPassword.getValue();
      cfg.secret = pSecret.getValue();
      cfg.mqttUrl = pUrl.getValue();
      cfg.tableId = pTable.getValue();
      cfg.activeLow = String(pLow.getValue()) != "0";
      long r = String(pRet.getValue()).toInt();
      cfg.returnSeconds = r >= 1 && r <= 30 ? (uint32_t)r : 8;
#ifdef AURA_4G
      cfg.link = String(pLink.getValue());
      cfg.link.trim();
      cfg.link.toLowerCase();
      if (cfg.link != "wifi") cfg.link = "4g";
      cfg.apn = pApn.getValue();
      cfg.apn.trim();
#endif
      cfg.deviceId.trim();
      cfg.tableId.trim();
      cfg.tableId.toUpperCase();
      saveConfig();
      relayRelease();  // the active level may have changed
    }
    // Done once the settings are in and the chosen network is there; a moment later, so the
    // phone gets the "saved" page first.
    if (!done && configured() && (useCell() || WiFi.status() == WL_CONNECTED)) {
      done = true;
      doneAt = millis();
    }
    if (done && millis() - doneAt > 3000) break;
    delay(10);
  }
  wm.stopConfigPortal();
  if (!configured()) ESP.restart();  // nothing to run with yet: start over
}

// ---------------------------------------------------------------- button
static int lastRaw = HIGH, stable = HIGH;
static uint32_t lastChange = 0;

static void pollButton() {
  int raw = digitalRead(BUTTON_PIN);
  if (raw != lastRaw) {
    lastRaw = raw;
    lastChange = millis();
  }
  if (millis() - lastChange > DEBOUNCE_MS && raw != stable) {
    stable = raw;
    if (stable == LOW) {  // pressed
      bool ran = idle();
      if (ran) relayRun(cfg.overrideSeconds);
      sendEvent("manual_override", ran ? cfg.overrideSeconds : 0);
      sendStatus();
    }
  }
}

// ---------------------------------------------------------------- main
void setup() {
  // Relay off before anything else: a reboot must never release the balls. The actuator
  // drives back to its resting place if it was anywhere else.
  loadConfig();
  pinMode(RELAY_PIN, OUTPUT);
  relayRelease();
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.printf("Aura Pool %s, %s\n", AURA_FW_VERSION, useCell() ? "4G" : "Wi-Fi");

  setWatchdog(WDT_TIMEOUT_MS);
  esp_task_wdt_add(NULL);

  // Holding the button for 10 s at power-on reopens the setup portal.
  uint32_t t0 = millis();
  bool held = digitalRead(BUTTON_PIN) == LOW;
  while (held && millis() - t0 < 10000) {
    esp_task_wdt_reset();
    delay(50);
    held = digitalRead(BUTTON_PIN) == LOW;
  }
  runPortal(held);

#ifdef AURA_4G
  if (useCell()) {
    WiFi.mode(WIFI_OFF);  // the setup portal is done with the radio
    cellStart();
  } else {
    pinMode(BOARD_POWERON, OUTPUT);
    digitalWrite(BOARD_POWERON, LOW);  // modem stays off on Wi-Fi
  }
#endif

  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  startMqtt();
}

static uint32_t lastBeat = 0, downSince = 0;

void loop() {
  esp_task_wdt_reset();
  if (relayOn && (int32_t)(millis() - relayOffAt) >= 0) {
    relayRelease();  // the actuator pushes the slide back out
    sendStatus();
  }
  pollButton();
#ifdef AURA_4G
  if (useCell()) cellLoop();
#endif
  if (netUp()) {
    downSince = 0;
    if (!mqttUp && reconnectAt && (int32_t)(millis() - reconnectAt) >= 0) {
      reconnectAt = 0;
      esp_mqtt_client_reconnect(mqtt);
    }
  } else {
    if (!downSince) downSince = millis();
    if (!useCell()) {
      static uint32_t lastTry = 0;
      if (millis() - lastTry > 10000) {
        lastTry = millis();
        WiFi.reconnect();
      }
    }
    // Long outages: start again from a clean modem or radio, but never in the middle of a game.
    if (millis() - downSince > NET_DOWN_REBOOT_MS && idle()) ESP.restart();
  }
  if (mqttUp && millis() - lastBeat > HEARTBEAT_MS) {
    lastBeat = millis();
    sendStatus();
  }
  delay(5);
}
