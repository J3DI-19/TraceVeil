# Phase 3 local demonstration

Phase 3 uses authenticated HTTP ingestion and replayable SSE. Physical hardware is optional: any authorized device capable of HTTPS/JSON can implement the same contract, while `backend/simulate_live.py` is the acceptance path.

## Configure and run

1. Copy `.env.example` to `backend/.env` and replace the demonstration source token. `LIVE_SOURCE_TOKENS` maps each allow-listed `source_id` to its environment-only token.
2. Start FastAPI and Vite using the root README instructions.
3. Run a scenario from `backend/` with the token that matches the environment:

```powershell
python simulate_live.py --scenario normal --token replace-with-a-long-random-token
python simulate_live.py --scenario malformed --token replace-with-a-long-random-token
python simulate_live.py --scenario reconnect --token replace-with-a-long-random-token
python simulate_live.py --scenario suspicious --count 10 --token replace-with-a-long-random-token
```

The simulator creates a case and capture session when `--case-id` is omitted. The suspicious scenario sends ten authentication failures inside the deterministic rule window and should produce a persisted `AUTH-001` alert. The malformed scenario produces an ingestion issue, not a canonical event. Reusing an identical source sequence within a session produces a duplicate receipt.

## Simulate an alert from Live Monitor

**Simulate alert** is enabled during an active capture. It calls
`POST /api/v1/live-sessions/{session_id}/simulate-alert`. The backend queues
authentication-failure events under the `traceveil-simulator` source and a
separate `simulated-auth-*` device. The event count follows the configured
`AUTH-001` threshold. The normal worker, normalizer and detector produce the
saved alert; the endpoint returns 202/`queued`, not a claim of finished detection.

Test events retain `simulated: true` and a simulation ID. Alerts are titled
`[SIMULATED]`, and each run is audited. Repeats within five seconds return 429;
stopped captures reject simulation requests. The internal simulator has no
external ingestion token and does not consume physical device sequences.
Test records remain in the selected case and its later analysis and reports.
The button does not send email.

## Browser and historical review

Open the URL printed by the simulator. The live screen reconnects with `Last-Event-ID`, bounds its display buffers, and can pause rendering without stopping backend capture. Stop capture from the browser, then open the case event, alert, timeline, graph, analytics, report, and audit tabs to confirm historical persistence.

## Grounded assistant and reports

Open Assistant with the case selected. If Ollama is unavailable, a retryable offline message is expected and investigation remains usable. When available, assistant citations link only to retrieved persisted records. In the Reports tab, create and generate a PDF, explicitly approve it, and download it. Email requires another approved, unchanged draft and a final send action.

For a local delivery demo, configure `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, and an SMTP sink such as Mailpit. Add only the sink recipient domain to `SMTP_ALLOWED_RECIPIENT_DOMAINS`. Traceveil never retries `delivery_unknown` automatically.

## Hardware-neutral integration

POST UTF-8 JSON matching `LiveTelemetryInput` to `/api/v1/live/telemetry` with `X-Traceveil-Source-Token`. Keep payloads below 64 KiB and below 30 messages/second/source. Preserve monotonically increasing `sequence` values where the source supports them. Device clocks must send timezone-aware timestamps; out-of-order observations remain valid and retain their original UTC time.
