# Aura Pool table controller (ESP32)

One ESP32 per table. It keeps the ball-release solenoid shut until the server sends a signed
unlock, runs the relay for the command's duration (hard cap 60 s), and acknowledges. The
override button releases the balls locally and reports the press. Nothing else switches the relay.

## Wiring

| ESP32 | Goes to |
|---|---|
| IO26 | Relay module IN (drives the solenoid) |
| IO27 | Override button, other side to GND (internal pull-up, 50 ms debounce) |
| 5V / GND | Relay module VCC / GND |

Most relay boards switch on a LOW input. The active level is a setting in the setup portal
(`1` = active LOW, the default; `0` = active HIGH). The relay is driven off before anything else
at boot, so a reset never releases the balls.

## Build and flash

```
pio run -t upload
pio device monitor
```

`platformio.ini` pins espressif32 6.9.0 (Arduino-ESP32 2.x), WiFiManager 2.0.17 and ArduinoJson
7.2.1. The code also builds on Arduino-ESP32 3.x (ESP-IDF 5); both MQTT config layouts are handled.

## Setting it up for a table

1. In the admin console, open the table and choose **Provision device**. The device ID, password,
   HMAC secret and MQTT URL are shown **once**. Keep the screen open.
2. Power the ESP32. On first boot it opens a Wi-Fi network called `AuraPool-Setup`.
3. Join it from a phone, pick the venue's Wi-Fi, and paste the four values plus the table ID (T001).
4. It joins the venue Wi-Fi, syncs the clock (NTP), connects to the broker and appears **online**
   in the console within 30 seconds. Send a **test unlock** from the console to check the relay.

To change Wi-Fi or credentials later, hold the override button for 10 seconds while powering on.

## What it does

- MQTT over TLS (`wss://…/mqtt`, certificates checked against the built-in CA bundle), its own
  credentials, and only its own topics (the broker refuses anything else).
- Heartbeat every 30 s on `pool/{table}/status`, retained; last will `{"online":false}`.
- Commands on `pool/{table}/cmd` are refused (`ack: rejected`) if the HMAC-SHA256 signature is
  wrong, the command is older than 60 s or past its expiry, or its `cmd_id` is one of the last 50
  it ran (it replies `duplicate`, which the server counts as delivered). While the relay is on, a
  new command gets `busy`.
- The override button runs the relay for the last command's duration and publishes
  `{"type":"manual_override"}` on `pool/{table}/event`. The server counts presses and alerts the
  owner and admin on unusual use.
- Hardware watchdog (15 s), Wi-Fi retry every 10 s, MQTT reconnect backoff 1 s → 60 s, config in NVS.
- Signed OTA updates are Phase 3.

## Testing without hardware

`api/scripts/device-sim.ts` behaves exactly like this firmware over MQTT. See the API README.
