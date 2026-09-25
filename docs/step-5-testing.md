# Step 5 - Testing

Three ladders. Climb them in order: each catches a different class of
problem and the higher rungs assume the lower ones already pass. The
merge-gate table at the bottom is the PR #8 review's acceptance
criteria.

## Ladder 1 - Automated (no hardware, no broker)

Runs entirely in the backend virtualenv. Fastest signal; the required
CI check.

```bash
cd backend
pip install -e '.[dev]'
pytest tests/test_live_telemetry_contract.py \
       tests/test_phase3_api.py \
       tests/test_mqtt_bridge_forwarding.py \
       tests/test_step5_audit_signals.py -q
```

What each file proves:

- `test_live_telemetry_contract.py` - the existing `LiveTelemetryInput`
  contract still accepts the shape the ESP32 sketch emits.
- `test_phase3_api.py` - the HTTP collector, token auth, receipts, SSE
  replay, and audit trail behave.
- `test_step5_audit_signals.py` (Step 5) - TV5-11 sequence integrity
  (exact replay -> duplicate + audit; same-seq-different-payload ->
  `live_sequence_collision`; lower-unseen-sequence `100 -> 99` ->
  `live_sequence_regression`; high-water persists across sessions) and
  TV5-12 auth-failure auditing (bounded, secret-free, IP-primary rate
  limit that rotating source_ids cannot bypass, bounded LRU).
- `test_mqtt_bridge_forwarding.py` (Step 5) - drives the real
  `hardware/mqtt_bridge/bridge.py` against the FastAPI TestClient. Ten
  cases:
  - end-to-end forward + backend ACK publish (TV5-09).
  - LWT status becomes heartbeat.
  - topic vs payload `source_id` mismatch is refused (TV5-03).
  - unregistered topic sources are dropped.
  - transient 5xx retries with backoff (TV5-07).
  - terminal 4xx dead-letters immediately (TV5-07).
  - backend outage keeps frames in the spool and drains them on
    recovery (TV5-07).
  - `configure_tls` refuses to run without CA/cert/key (TV5-02).
  - `LIVE_SOURCE_TOKENS` parses the JSON backend format.
  - topic parsing rejects malformed shapes.

Full suite (all 92 backend tests) must still be green:

```bash
pytest -q
```

## Ladder 2 - Broker + bridge integration (no hardware)

Runs real mosquitto with the lab PKI and ACL, and the real
`bridge.py` process. Confirms the TLS/ACL wiring is correct and that
the bridge behaves in an actual network path. Same steps CI runs.

Prereqs: `mosquitto`, `mosquitto-clients`, `openssl`, plus the bridge
requirements (`pip install -r hardware/mqtt_bridge/requirements.txt`).

Generate the lab PKI once:

```bash
bash tests/step5/generate_lab_pki.sh
```

Start the broker (one terminal):

```bash
bash tests/step5/start_broker.sh
```

Run the two negative assertions (they exit 0 when the security
properties hold):

```bash
bash tests/step5/assert_untrusted_client_rejected.sh   # TV5-02
bash tests/step5/assert_topic_acl_enforced.sh          # TV5-03
```

Optional live demo. In two more terminals with `backend/.env` set to
`LIVE_SOURCE_TOKENS='{"live-lab-01":"traceveil-demo-token"}'` and the
backend running:

```bash
cd hardware/mqtt_bridge
LIVE_SOURCE_TOKENS='{"live-lab-01":"traceveil-demo-token"}' \
TV_API_BASE=http://127.0.0.1:8000/api/v1 \
TV_MQTT_HOST=127.0.0.1 TV_MQTT_PORT=8883 TV_MQTT_TLS=1 \
TV_MQTT_CA_FILE=$(pwd)/../../tests/step5/pki/ca.crt \
TV_MQTT_CLIENT_CERT=$(pwd)/../../tests/step5/pki/tv-bridge.crt \
TV_MQTT_CLIENT_KEY=$(pwd)/../../tests/step5/pki/tv-bridge.key \
TV_SPOOL_PATH=./bridge_spool.sqlite \
python bridge.py
```

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00)
mosquitto_pub -h 127.0.0.1 -p 8883 \
  --cafile tests/step5/pki/ca.crt \
  --cert   tests/step5/pki/esp32-lab-01.crt \
  --key    tests/step5/pki/esp32-lab-01.key \
  -t tv/dev/esp32-lab-01/telemetry -q 1 -m "{
    \"schema_version\":\"1.0\",\"case_id\":1,
    \"source_id\":\"esp32-lab-01\",\"device_id\":\"esp32-lab-01\",
    \"event_type\":\"telemetry\",\"observed_at\":\"$NOW\",
    \"sequence\":1,\"metrics\":{\"temperature_c\":23.1}
  }"
```

The bridge should log `forwarded source=esp32-lab-01 seq=1 status=202`
and immediately publish `tv/dev/esp32-lab-01/ack {"sequence": 1}`.

## Ladder 3 - Physical ESP32 on the bench

For a first physical Step 12 demonstration, follow the one-sensor
[DHT22 guide](../hardware/esp32/traceveil_dht22/README.md). The procedure
below is for the original multi-device sketch and its advanced scenarios.

Prereqs: ESP32-WROOM-32, DHT22 on GPIO 4, HC-SR501 on GPIO 27, relay
on GPIO 26, ISOLATED sense tap on GPIO 25 (input; feed from a
high-impedance divider or opto-coupler), momentary button between
GPIO 33 and GND (INPUT_PULLUP). NEVER short GPIO 26 to 3V3 (TV5-01).

```bash
# 1. Per-node config
cp hardware/esp32/traceveil_node/config.h.example \
   hardware/esp32/traceveil_node/config.h
$EDITOR hardware/esp32/traceveil_node/config.h
# Required edits: SSID/PSK, TV_CASE_ID, TV_SOURCE_TOKEN, TV_NTP_SERVER_1,
# TV_HTTP_ROOT_CA_PEM (or, for MQTT, all three PEM blocks). The sketch
# halts on boot if any required material is missing.

# 2. Build and flash
arduino-cli core install esp32:esp32
arduino-cli lib install "DHT sensor library" "Adafruit Unified Sensor" \
  "ArduinoJson" "PubSubClient"
arduino-cli compile --fqbn esp32:esp32:esp32 \
  hardware/esp32/traceveil_node/traceveil_node.ino
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 \
  hardware/esp32/traceveil_node/traceveil_node.ino

# 3. Watch the node
arduino-cli monitor -p /dev/ttyUSB0 -c baudrate=115200
```

Acceptance walk:

1. Within 3 s of boot, `GET /api/v1/cases/<id>/live/devices` shows
   the source `online` and a heartbeat receipt exists.
2. Telemetry frames arrive at the configured 3 s cadence.
3. Press the command button: a `command` event with
   `metrics.target="relay"` appears, followed by a `device_state`
   event where the sensed relay state matches the commanded state.
4. Run the scenario scripts under `hardware/scenarios/` in turn:
   - `replay.sh` -> backend returns the ORIGINAL receipt with
     `duplicate=true` (TV5-11).
   - `tamper.sh` -> row in `live_ingest_issues`.
   - `rogue.sh` -> HTTP 401; no audit row (TV5-12).
   - `environment.sh` -> environment detection rule fires (see rule
     dependency note below).
   - `actuation.sh` -> flip the relay via the ISOLATED manual
     override; a `device_state` appears with no preceding `command`
     for that transition (TV5-01, TV5-06).
   - `reconnect.sh` -> `link=offline` heartbeat, then clean resume
     from `Last-Event-ID`.
5. Stop the live session in the browser, power the ESP32 down, and
   open the case tabs. Every scenario must still be investigable
   from persistence alone.

## Merge gates (PR #8 review)

| Gate | Property | Evidence |
| --- | --- | --- |
| G1 | Safe hardware procedure | `hardware/scenarios/actuation.sh` uses the isolated relay override; the old GPIO-to-3V3 instruction is removed and forbidden. |
| G2 | Working mutual TLS | `configure_tls` refuses to start without CA/cert/key; sketch `assert_transport_config()` halts if PEMs absent; CI `bridge-broker` runs the untrusted-cert rejection AND `real_bridge_test.py`, which starts the actual `bridge.py` over mTLS and asserts forward + token + ACK. |
| G3 | Per-device topic authorization | `hardware/mqtt_bridge/traceveil.acl` pins each CN to its own topics; CI `assert_topic_acl_enforced.sh` uses the `tv-bridge` cert as the authorized reader and proves lab-01 cannot publish as lab-02 while lab-02 can publish to its own topic. |
| G4 | Valid time source | Sketch `await_ntp_or_halt()` blocks publication until NTP passes `TV_NTP_MIN_EPOCH`. |
| G5 | Durable delivery | Bridge SQLite spool + backoff + dead-letter (`test_spool_survives_backend_outage_then_recovers`); device delivery policy (`delivery_policy.h`) proven by `delivery_policy_test.cpp` across all five loss scenarios; documented RAM-loss-on-power residual. |
| G6 | Accurate scenario behavior | Scenario scripts and `docs/step-5-live-iot.md` match the backend: replay = duplicate + audit, regression/collision = 409 + audit, rogue = 401 + one bounded audit row. |
| G7 | Protected transport | `TV_HTTP_TLS` defaults to 1; the CA guard applies in MQTT mode too (HTTPS failover); sketch halts if plaintext targets a non-loopback host. |
| G8 | Expanded CI | `.github/workflows/step5-integration.yml` runs four required jobs: `backend-step5` (audit + bridge unit tests), `bridge-broker` (real mosquitto + mTLS + ACL + real bridge), `native-cpp` (ack-buffer + delivery-policy), `esp32-compile` (HTTP and MQTT transport modes). Path filters include the backend service/api/config/db and both Step 5 test files. Configure these as required checks in branch protection. |

## Rule dependency note

`environment.sh` and `actuation.sh` depend on Step 6 detection rules
that fire on `metrics.threshold_over_temp = true` and on a
`device_state` frame whose `metrics.relay` transitions without a
preceding `command` event for the same target. If your
`AnalysisService` does not ship those rules yet, add them to
`backend/app/analysis/detection.py` or retarget the two scenarios at
rules that exist (the `AUTH-001` path used by `simulate_live.py
--scenario suspicious` is definitely present).

## When something fails

- **`HTTP 401 invalid_live_source_token`** - source_id is not in
  `LIVE_SOURCE_TOKENS` or the token does not match. Restart FastAPI
  and the bridge after editing `backend/.env`.
- **`HTTP 409 live_source_already_active`** - source is still bound
  to an active session. Stop it via `POST
  /api/v1/live-sessions/<uuid>/stop` or the browser Stop button.
- **`HTTP 422 malformed_live_telemetry`** - the frame violates the
  canonical contract (timezone-naive `observed_at`, invalid metric
  name, non-finite float, extra top-level field).
- **Bridge silent, broker silent** - check `mosquitto -v` output.
  Most common causes: client cert CN does not match `TV_SOURCE_ID`,
  or the CA in `TV_MQTT_CA_FILE` does not match the broker cert.
- **ESP32 halts with "NTP failed"** - lab has no route to the
  configured NTP server. Provision a local one and set
  `TV_NTP_SERVER_1`.
- **ESP32 halts with "TV_MQTT_CA_PEM is unset"** - config.h still
  contains a `REPLACE-WITH` placeholder.
