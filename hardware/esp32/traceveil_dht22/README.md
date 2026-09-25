# One-sensor ESP32 demo (recommended for Step 12)

This is the default physical demo sketch. It reads one DHT22/AM2302 and
POSTs real `temperature_c` and `humidity_pct` measurements to the existing
`/api/v1/live/telemetry` endpoint over HTTPS. The original multi-device
`../traceveil_node/traceveil_node.ino` remains available for the relay,
motion and MQTT demonstrations.

## Parts and wiring

- ESP32-WROOM-32 development board, powered through its USB data cable.
- DHT22/AM2302 **module**, with VCC -> ESP32 3V3, GND -> GND, DATA -> GPIO 4.
- Three jumper wires. A breadboard helps if the module has pins instead of
  a cable. Add a 10 kΩ pull-up from DATA to 3V3 if the module has none.

Check the labels on the actual module: pin order differs across products.
Nothing connects to the sketch's unused PIR, relay, or button pins.

## Backend and network

1. Create a case in Traceveil and note its numeric ID. Put a random source
   token in `backend/.env` as `LIVE_SOURCE_TOKENS={"esp32-lab-01":"<token>"}`;
   restart FastAPI. Start capture in Live Monitor for `esp32-lab-01` **before**
   booting the ESP32.
2. Run FastAPI on the laptop and expose its `/api/v1/` routes to the ESP32
   through an HTTPS reverse proxy on the lab network. The `127.0.0.1:8000`
   README development address is not reachable from the ESP32. The proxy's
   certificate must match `TV_HTTP_HOST`; paste its issuing CA into
   `TV_HTTP_ROOT_CA_PEM`. Do not disable certificate validation or send the
   source token over plaintext HTTP.
3. Give the ESP32 reachable NTP. Its clock must be plausible before any frame
   is emitted. The backend laptop should also have synchronized time.

## Flash

Copy `config.h.example` to `config.h` here and set Wi-Fi, case ID, source
token, HTTPS host/CA and NTP. `config.h` is gitignored.

```powershell
arduino-cli core install esp32:esp32
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" "ArduinoJson"
arduino-cli compile --fqbn esp32:esp32:esp32 hardware/esp32/traceveil_dht22
arduino-cli upload --fqbn esp32:esp32:esp32 -p COM3 hardware/esp32/traceveil_dht22
arduino-cli monitor -p COM3 -c baudrate=115200
```

Replace `COM3` with the port shown by `arduino-cli board list`.

## Acceptance and limits

Serial should print `sample sequence=...` followed by `accepted sequence=...`.
Live Monitor should show the same source and repeated telemetry roughly every
three seconds. Gently warm the sensor to show real readings changing. Stop
capture and open the case's event and timeline views to verify persistence.

If a POST fails, this sketch retries **the exact same JSON and sequence**. It
does not take another measurement until the pending frame is accepted; after
a hard power loss, that one RAM-held frame is lost. A 401 or 409 requires an
operator to fix configuration or sequence state. Do not erase ESP32 NVS and
reuse the same source ID without resetting the backend's source sequence
state or assigning a new source ID and token. The sketch does not claim an
alert merely because temperature rises: the backend currently has no fixed
temperature-threshold rule. A live alert requires a supported existing rule
or a separately implemented, verified temperature rule.
