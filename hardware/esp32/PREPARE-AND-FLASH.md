# DHT22 hardware setup

## Prepared before connecting the board

The first sketch is `dht22_usb_test/dht22_usb_test.ino`. It prints real
temperature and humidity over USB, with no network configuration required.
The existing `traceveil_dht22/traceveil_dht22.ino` is the second sketch: it
sends real readings to Traceveil over authenticated HTTPS.

A matching random source token for `esp32-lab-01` has been prepared in the
local `backend/.env` and `traceveil_dht22/config.h` files. Both are ignored
by Git. Wi-Fi, case ID, HTTPS endpoint and CA have now been configured locally
for the working phone-hotspot capture described below.

Local preparation checked on 2026-10-21:

- Installed Arduino CLI, ESP32 core 2.0.17, DHT sensor library 1.4.7,
  Adafruit Unified Sensor 1.1.15 and ArduinoJson 6.21.5 under `.runtime/arduino`.
- Both sketches compiled successfully for `esp32:esp32:esp32`. USB test:
  265,681 bytes flash; live sketch: 901,517 bytes flash. The live build still
  contains network placeholders and is not ready for capture.
- Existing backend tests in `test_live_telemetry_contract.py` and
  `test_phase3_api.py` passed using isolated test storage.
- At that point no board upload or physical test had occurred.

Physical USB check completed on 2026-10-23:

- Installed the CP210x driver after Windows administrator approval; the board
  appeared on COM7 with no device error. The driver catalog's Microsoft
  signature and the x64 driver's Silicon Labs signature were verified.
- Uploaded `dht22_usb_test` successfully; esptool identified an
  ESP32-D0WD-V3 revision 3.1 and verified the flashed data.
- Read five consecutive samples at 115200 baud: 31.00 C and 58.00% humidity.
  The sensor is responding over GPIO 4; independent accuracy calibration
  has not been performed.
- Wi-Fi and end-to-end HTTPS were not yet configured at the USB-only stage.

Live setup prepared on 2026-10-23:

- Dashboard and backend run on loopback ports 5173 and 8000.
- Caddy 2.11.7 provides HTTPS on the laptop's Wi-Fi address
  `10.167.34.155:8443` on the phone hotspot, forwarding only `/api/v1/live/telemetry` and
  `/api/v1/health`. Its admin API is disabled. The local CA is embedded in
  the ignored firmware config; TLS verification remains enabled.
- Windows firewall access is limited to the Caddy executable, TCP 8443,
  the Wi-Fi interface, that local address, and local-subnet clients.
- Dedicated physical-sensor case: 8. The local capture state, certificates,
  credentials and service logs are in the ignored `.runtime/esp32-live/`.
- Configured live firmware was compiled and uploaded to COM7. Network
  diagnostics print disconnect reasons and visible network names without
  printing passwords or source tokens.
- Current working network: `J3DI's Phone`, in 2.4 GHz hotspot mode. Both the
  laptop and ESP32 joined. Shashank was previously too weak for a successful
  ESP32 handshake at this location.
- The original IP-only server certificate failed verification in this
  ESP32 TLS stack. A replacement certificate, signed by the same local CA,
  contains the address as both IP SAN and numeric DNS SAN, plus matching CN.
  Both Python's modern IP validator and the ESP32 now verify it successfully.
  The certificate and key are local ignored files `device-server.crt` and
  `device-server.key`; the certificate expires one year after issuance and
  must be reissued when it expires or the endpoint IP changes. The local
  issuance helper is `.runtime/esp32-live/issue-device-certificate.ps1`.
- Verified three consecutive `accepted sequence=...` messages over serial.
  The backend subsequently reported one online device, 15 persisted real
  telemetry events, zero malformed events and zero alerts. Latest readings
  at that check were approximately 31.8 C and 61.1% humidity.
- Capture remains active for case 8 and source `esp32-lab-01`. USB currently
  supplies power; telemetry travels over hotspot Wi-Fi and HTTPS. Keep the
  laptop services, hotspot and ESP32 powered while capturing.

To restart local services after closing them or restarting Windows:

```powershell
.\scripts\start-esp32-demo.ps1
```

This reuses running services and does not start a new capture session.
Open `http://127.0.0.1:5173/live?case=8` and check capture status. If the
laptop's Wi-Fi IP changes, the server certificate, proxy, firmware and firewall need updating
before the board can connect. Keep the local CA storage; replacing it
requires reflashing the firmware with the new CA certificate.

Both expect a DHT22 module wired as follows, with USB unplugged while wiring:

| Module | ESP32 |
| --- | --- |
| + | 3V3 |
| - | GND |
| OUT | GPIO 4 |

Direct jumper connections are sufficient; a breadboard is optional.
Confirm the board model before uploading. `ISM 2.4G 802.11b/g/n` is a radio
description, not a board model. Commands below assume a classic ESP32-WROOM
development board, using `esp32:esp32:esp32`. An S3 or C3 needs its own target.

## When a USB data cable is available

From a PowerShell terminal in the repository root:

```powershell
# Uses the project-local compiler and libraries prepared in .runtime/arduino.
$cli = Join-Path $PWD '.runtime/arduino/arduino-cli.exe'
$cfg = Join-Path $PWD '.runtime/arduino/arduino-cli.yaml'
& $cli --config-file $cfg board list

# Replace COM3 with the actual board port. Confirm the board model first.
& $cli --config-file $cfg compile --fqbn esp32:esp32:esp32 hardware/esp32/dht22_usb_test
& $cli --config-file $cfg upload --fqbn esp32:esp32:esp32 -p COM3 hardware/esp32/dht22_usb_test
& $cli --config-file $cfg monitor -p COM3 -c baudrate=115200
```

Expected output every three seconds:

```text
Temperature: 28.40 C | Humidity: 61.20 %
```

If uploading fails while connecting, some classic boards need BOOT held
briefly during the connection attempt. If no port appears, check that the
cable supports data and identify the board's USB interface before choosing
a driver. Close the serial monitor before another upload.

## Connect the verified sensor to Traceveil

1. Edit the ignored `traceveil_dht22/config.h` locally. Set your 2.4 GHz Wi-Fi
   name/password, actual case ID, and source token. Do not commit credentials.
2. Use the same source ID and token in `backend/.env` under
   `LIVE_SOURCE_TOKENS`. Preserve any existing source entries. Restart the
   backend after changing its environment.
3. Configure an HTTPS reverse proxy reachable from the ESP32, forwarding to
   the existing backend. Set `TV_HTTP_HOST`, `TV_HTTP_PORT`, and the issuing
   CA certificate in the firmware. The hostname/IP must match the certificate
   and be resolvable/reachable by the ESP32. `localhost` and `127.0.0.1` refer
   to the ESP32 itself, not the laptop. Do not disable TLS verification.
4. Ensure the ESP32 can reach the configured NTP server for UTC timestamps.
5. Create/select the case in Traceveil and start Live Monitor capture for
   `esp32-lab-01` before booting the live sketch.
6. Compile and upload the live sketch in place of `dht22_usb_test` in the
   commands above. Monitor at 115200 baud.
7. Expect `sample sequence=...` followed by `accepted sequence=...`. Verify
   live readings, then stop capture and check that case events persist.

The remaining placeholder configuration deliberately prevents capture until configured.
It is not evidence that Wi-Fi, HTTPS, the physical board, or sensor works.
Do not erase board NVS and reuse the same source identity without addressing
the backend's stored sequence state. See `traceveil_dht22/README.md` for
retry behavior and limitations.
