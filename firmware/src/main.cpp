// Aura Pool table controller, ESP32 (Arduino framework).
//
// One device per table. It holds the ball-release solenoid shut until the server sends a
// signed unlock command, then runs the relay for the command's duration (never more than
// 60 s) and acknowledges. The override button on the table does a local unlock and reports
// it. Nothing else ever switches the relay.
//
// Protocol (see api/src/devices/protocol.ts):
//   subscribe pool/{table}/cmd     {cmd_id, action:"unlock", duration_s, issued_at, expires_at, nonce, sig}
//   publish   pool/{table}/ack     {cmd_id, result: ok|rejected|busy, reason, ts}
//   publish   pool/{table}/status  heartbeat every 30 s, retained; last will {"online":false}
//   publish   pool/{table}/event   {type:"manual_override", ts, duration_s}
//   sig = hex(HMAC-SHA256(secret, "cmd_id|action|duration_s|issued_at|expires_at|nonce"))
//
// Setup: first boot (or holding the button for 10 s while powering on) opens a Wi-Fi access
// point "AuraPool-Setup". Join it, pick the venue's Wi-Fi, and paste the device id, password,
// HMAC secret and MQTT URL the console showed when the table was provisioned.

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

#ifndef AURA_FW_VERSION
#define AURA_FW_VERSION "1.0.0"
#endif

// ---------------------------------------------------------------- hardware
static const int RELAY_PIN = 26;      // relay driving the solenoid
static const int BUTTON_PIN = 27;     // override button, to ground, internal pull-up
static const uint32_t MAX_ON_MS = 60000;
static const uint32_t DEBOUNCE_MS = 50;
static const uint32_t HEARTBEAT_MS = 30000;
static const uint32_t WDT_TIMEOUT_MS = 15000;
static const int COMMAND_TTL_S = 60;

// ---------------------------------------------------------------- configuration (NVS)
struct Config {
  String deviceId, password, secret, mqttUrl, tableId;
  bool activeLow = true;            // most relay boards switch on a LOW input
  uint32_t overrideSeconds = 20;    // updated from the last command's duration
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
  prefs.end();
}

static bool configured() {
  return cfg.deviceId.length() && cfg.password.length() && cfg.secret.length() && cfg.mqttUrl.length() && cfg.tableId.length();
}

// ---------------------------------------------------------------- relay
static volatile bool relayOn = false;
static uint32_t relayOffAt = 0;

static void relayWrite(bool on) {
  digitalWrite(RELAY_PIN, (on ^ cfg.activeLow) ? HIGH : LOW);
  relayOn = on;
}

static void relayRun(uint32_t seconds) {
  uint32_t ms = seconds * 1000UL;
  if (ms > MAX_ON_MS) ms = MAX_ON_MS;  // hard cap, whatever the command says
  relayOffAt = millis() + ms;
  relayWrite(true);
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
  d["rssi"] = WiFi.RSSI();
  d["uptime_s"] = millis() / 1000;
  d["relay"] = relayOn ? "on" : "off";
  d["ip"] = WiFi.localIP().toString();
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
  if (relayOn) {
    sendAck(cmdId, "busy", "relay_on");
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

// ---------------------------------------------------------------- Wi-Fi setup portal
static void runPortal(bool force) {
  WiFiManager wm;
  WiFiManagerParameter pDevice("device", "Device ID", cfg.deviceId.c_str(), 16);
  WiFiManagerParameter pPassword("password", "Device password", cfg.password.c_str(), 64);
  WiFiManagerParameter pSecret("secret", "HMAC secret", cfg.secret.c_str(), 96);
  WiFiManagerParameter pUrl("mqtt", "MQTT URL (wss://…/mqtt)", cfg.mqttUrl.c_str(), 160);
  WiFiManagerParameter pTable("table", "Table ID (e.g. T001)", cfg.tableId.c_str(), 8);
  WiFiManagerParameter pLow("activeLow", "Relay active level: LOW=1, HIGH=0", cfg.activeLow ? "1" : "0", 2);
  wm.addParameter(&pDevice);
  wm.addParameter(&pPassword);
  wm.addParameter(&pSecret);
  wm.addParameter(&pUrl);
  wm.addParameter(&pTable);
  wm.addParameter(&pLow);
  wm.setConfigPortalTimeout(300);
  bool saved = false;
  wm.setSaveParamsCallback([&]() { saved = true; });
  wm.setSaveConfigCallback([&]() { saved = true; });
  esp_task_wdt_delete(NULL);  // the portal blocks; don't let the watchdog reset it
  bool ok = force || !configured() ? wm.startConfigPortal("AuraPool-Setup") : wm.autoConnect("AuraPool-Setup");
  esp_task_wdt_add(NULL);
  if (saved) {
    cfg.deviceId = pDevice.getValue();
    cfg.password = pPassword.getValue();
    cfg.secret = pSecret.getValue();
    cfg.mqttUrl = pUrl.getValue();
    cfg.tableId = pTable.getValue();
    cfg.activeLow = String(pLow.getValue()) != "0";
    cfg.deviceId.trim();
    cfg.tableId.trim();
    cfg.tableId.toUpperCase();
    saveConfig();
    relayWrite(false);  // active level may have changed
  }
  if (!ok) ESP.restart();
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
      bool wasOn = relayOn;
      if (!wasOn) relayRun(cfg.overrideSeconds);
      sendEvent("manual_override", wasOn ? 0 : cfg.overrideSeconds);
      sendStatus();
    }
  }
}

// ---------------------------------------------------------------- main
void setup() {
  // Relay off before anything else: a reboot must never release the balls.
  loadConfig();
  pinMode(RELAY_PIN, OUTPUT);
  relayWrite(false);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);

#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t w = {.timeout_ms = WDT_TIMEOUT_MS, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_reconfigure(&w);
#else
  esp_task_wdt_init(WDT_TIMEOUT_MS / 1000, true);
#endif
  esp_task_wdt_add(NULL);

  // Holding the button for 10 s at power-on reopens the setup portal.
  uint32_t t0 = millis();
  bool held = digitalRead(BUTTON_PIN) == LOW;
  while (held && millis() - t0 < 10000) {
    esp_task_wdt_reset();
    delay(50);
    held = digitalRead(BUTTON_PIN) == LOW;
  }
  WiFi.mode(WIFI_STA);
  runPortal(held);

  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  startMqtt();
}

static uint32_t lastBeat = 0;

void loop() {
  esp_task_wdt_reset();
  if (relayOn && (int32_t)(millis() - relayOffAt) >= 0) {
    relayWrite(false);
    sendStatus();
  }
  pollButton();
  if (WiFi.status() != WL_CONNECTED) {
    static uint32_t lastTry = 0;
    if (millis() - lastTry > 10000) {
      lastTry = millis();
      WiFi.reconnect();
    }
  } else if (!mqttUp && reconnectAt && (int32_t)(millis() - reconnectAt) >= 0) {
    reconnectAt = 0;
    esp_mqtt_client_reconnect(mqtt);
  }
  if (mqttUp && millis() - lastBeat > HEARTBEAT_MS) {
    lastBeat = millis();
    sendStatus();
  }
  delay(5);
}
