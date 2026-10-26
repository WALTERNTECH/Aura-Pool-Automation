# Aura Pool table controller (ESP32)

One ESP32 per table. Payment in, balls out, with nobody touching the table: a signed unlock from
the server switches the relay on, a 12 V linear actuator pulls the table's ball-release slide in,
the gate lifts and the balls roll into the tray. When the unlock time is up (hard cap 60 s) the
relay switches off and the actuator pushes the slide back out. The override button releases the
balls locally and reports the press. Nothing else switches the relay.

The default build is for the **LilyGO T-A7670E**: an ESP32 with an A7670E 4G modem and SIM slot,
so a table needs no venue Wi-Fi. It can still use Wi-Fi if it's set to. A plain ESP32 dev board
works too, on Wi-Fi only.

## Wiring (T-A7670E)

| From | To |
|---|---|
| UPS box + (through a 5 A fuse) | +12 V terminal |
| UPS box − | GND terminal |
| +12 V terminal | LM2596 IN+, relay 1 NC, relay 2 NO |
| GND terminal | LM2596 IN−, relay 1 NO, relay 2 NC |
| LM2596 OUT+ (set to 5.1 V first) | Board VBUS, relay board VCC |
| LM2596 OUT− | Board GND, relay board GND |
| Board IO21 | Relay board IN1 and IN2, joined |
| Relay 1 COM | Actuator red lead |
| Relay 2 COM | Actuator black lead |
| Board IO22 | Override button, other side to GND (internal pull-up, 50 ms debounce) |
| Antenna socket | LTE antenna, outside the cabinet |

On this board the modem uses most pins; IO21 and IO22 are the free ones. Don't connect anything to
IO4 or IO5 on the header (modem power key and reset), and leave the board's own 18650 holder empty:
the UPS box covers power cuts. The board draws up to 2 A in bursts on VBUS.

The two relays switch together and reverse the actuator's polarity. Relays off: +12 V on the red
lead, and the actuator holds the slide out. Relays on: the polarity flips and it pulls the slide in.
If it moves the wrong way, swap its two leads. Its own limit switches stop it at each end, so match
its stroke to the slide's travel (often 50 mm).

On a plain ESP32 (`esp32dev` build) the relay board goes on IO26 and the button on IO27.

Most relay boards switch on a LOW input. The active level is a setting in the setup portal
(`1` = active LOW, the default; `0` = active HIGH). The relay is driven off before anything else at
boot, so a reset never releases the balls.

## Build and flash

```
pio run -t upload
pio device monitor
```

That builds `t-a7670e`, the default. For a plain ESP32 on Wi-Fi: `pio run -e esp32dev -t upload`.

`platformio.ini` uses the pioarduino platform 55.03.312-1 (Arduino-ESP32 3.3.12, ESP-IDF 5.5),
WiFiManager 2.0.17 and ArduinoJson 7.2.1, with the `min_spiffs` partition table (1.9 MB app).

With the Arduino CLI instead: board `esp32:esp32:esp32`, option `PartitionScheme=min_spiffs`, and
for the 4G board the flags `-DAURA_4G -DAURA_RELAY_PIN=21 -DAURA_BUTTON_PIN=22`.

## Setting it up for a table

1. In the admin console, open the table and choose **Provision device**. The device ID, password,
   HMAC secret and MQTT URL are shown **once**. Keep the screen open.
2. Put the data SIM in, screw on the LTE antenna, and power the table box. On first boot the board
   opens a Wi-Fi network called `AuraPool-Setup`.
3. Join it from a phone and open **Setup**. Set the connection to `4g` and the APN (`safaricom`
   on Safaricom, `internet` on Airtel), then paste the four values and the table ID (T001), and save.
   For Wi-Fi instead, set the connection to `wifi` and pick the network under **Configure WiFi**.
4. The modem registers, the clock syncs (NTP) and it connects to the broker. The table shows
   **online** in the console within about a minute. Send a **test unlock** from the console: the
   actuator pulls the slide in and the balls come out.

To change any of it later, hold the override button for 10 seconds while powering on.

**Actuator travel time** (default 8 s) is how long the actuator takes for a full stroke. After
each unlock the board waits this long for it to return before it takes the next one (the server
gets `busy` and retries), and it keeps the relay on at least this long plus 2 s.

## What it does

- MQTT over TLS (`wss://…/mqtt`, certificates checked against the built-in CA bundle), its own
  credentials, and only its own topics (the broker refuses anything else). Over 4G this runs on a
  PPP data call through the modem; signal (dBm), link (`4g` or `wifi`) and IP go in the heartbeat.
- Heartbeat every 30 s on `pool/{table}/status`, retained; last will `{"online":false}`.
- Commands on `pool/{table}/cmd` are refused (`ack: rejected`) if the HMAC-SHA256 signature is
  wrong, the command is older than 60 s or past its expiry, or its `cmd_id` is one of the last 50
  it ran (it replies `duplicate`, which the server counts as delivered). While the relay is on, or
  the actuator is still returning, a new command gets `busy` and the server retries.
- The override button runs the relay for the last command's duration and publishes
  `{"type":"manual_override"}` on `pool/{table}/event`. The server counts presses and alerts the
  owner and admin on unusual use.
- 4G: the modem is powered up and reset at boot, the data call uses CMUX (so the signal can still
  be read), and a call that gets no address in 60 s switches to plain data mode for the next boot.
- Hardware watchdog (15 s; 2 minutes while the modem starts), Wi-Fi retry every 10 s, MQTT
  reconnect backoff 1 s → 60 s, and a reboot after 5 minutes without a network, never in the middle
  of a game. Config in NVS.
- Signed OTA updates are Phase 3.

## Testing without hardware

`api/scripts/device-sim.ts` behaves like this firmware over MQTT. See the API README.
