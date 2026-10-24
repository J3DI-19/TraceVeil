# Traceveil

**AI-Assisted Real-Time Smart Home IoT Digital Forensics and Incident Response Platform**

Traceveil is a completed final-year academic prototype for investigating historical
IoT evidence and controlled live sensor activity. It turns accepted records into
explainable findings, bounded risk scores, correlated incidents, timelines,
device relationships and investigation reports, with optional local AI assistance.

**Project status — 24 October 2026:** all **176 planned roadmap items are
complete (100%)** for the documented one-sensor laboratory demonstration.
Real ESP32/DHT22 input, live updates, a controlled suspicious scenario and
persisted case investigation have been verified. The delivery record includes the implementation baseline
`180f204` and this documentation commit, **Finalize project delivery documentation**,
on `J3DI`. The final integration is recorded by its pull request into `main`. See the [completion report](docs/Completion_Report_2026-09-06.md)
for acceptance evidence and remaining operational follow-ups.

## What it does

- Imports evidence into cases, validates and hashes source files, and retains raw-record provenance.
- Normalizes batch records, authenticated HTTP telemetry and local USB sensor input into a common canonical event model.
- Applies deterministic detection, behavioural baselines, risk scoring, correlation and incident grouping.
- Presents findings, alerts, minute-based timelines, graphs and charts from persisted backend results.
- Displays real temperature/humidity values and incoming input records in Live Monitor, with replayable SSE and reconnect recovery.
- Detects a connected ESP32, installs USB firmware when needed, creates or selects a case and verifies the first saved reading through **Connect & start**.
- Runs an audited **Simulate alert** scenario through the normal detection pipeline, with clearly labelled test events and alerts.
- Preserves live activity for historical investigation, including analysis snapshots and evidence references.
- Provides case-scoped local AI chat, verified citations and allow-listed visualizations through Ollama.
- Generates structured PDF reports and editable email previews with separate approval and explicit-send controls.
- Exposes local SMTP setup, system health and an audit trail for investigation and delivery actions.

Python and the persisted evidence remain the computational authority. AI can
explain validated results; it does not invent forensic values, alter evidence,
execute attacks or send messages autonomously. Simulated scenarios remain
separate from real sensor measurements and are labelled in the saved records.

## Start the prepared demonstration

On the prepared Windows laptop:

1. Double-click **[Start Sensor.cmd](Start%20Sensor.cmd)** to start the local backend/frontend and open Live Monitor.
2. Connect the ESP32 with its micro-USB **data** cable.
3. In **USB sensor setup**, keep **Create a new case** selected or choose an existing case, then click **Connect & start**.
4. Wait for the first real reading to be saved. The monitor switches to that case automatically.
5. Click **Simulate alert** during capture to exercise the controlled authentication-failure scenario. Review its saved alert and the case’s Findings, Timeline and Visuals.
6. Use **Stop USB capture** or **Stop capture** when finished. Saved readings remain available in the case.

The dashboard is at [http://127.0.0.1:5173/live](http://127.0.0.1:5173/live).
The launcher uses the default browser; the same address can be opened in Opera GX.
It reuses running services and does not start capture by itself.

### Verified hardware

| Component | Configuration |
| --- | --- |
| Board | Robocraze ESP32 NodeMCU 30-pin, classic ESP32 target, CP2102 USB interface |
| Sensor | Three-pin DHT22 temperature/humidity module |
| Wiring | DHT22 **+ → 3V3**, **− → GND**, **OUT → GPIO 4** |
| Connection | Micro-USB data cable and direct jumper wires; breadboard optional |
| USB firmware | `hardware/esp32/traceveil_usb_sensor/traceveil_usb_sensor.ino` |

USB capture needs no hotspot, Wi-Fi credentials, NTP or HTTPS proxy. It uses the
laptop’s UTC receipt time, recorded as `timestamp_source=host_received_utc` in raw
metrics. Keep the laptop clock correct and USB connected throughout capture.
Changing the selected capture case ends the source’s previous active capture.
Switching dashboard pages leaves capture running; restarting the backend or
unplugging the board requires another **Connect & start**.

First-use firmware installation replaces the current sketch with USB firmware;
subsequent starts reuse it. Close any serial monitor using the board’s port.
If several CP2102 boards are attached, choose the intended port. Missing hardware,
busy ports, failed installation and missing sensor readings produce setup errors.

The prepared compiler, libraries, driver, source credential and runtime files are
local prerequisites; they are excluded from Git. A fresh clone needs initial
hardware/tool setup before the USB button can provision a board. See the
[USB setup guide](hardware/esp32/USB-ONE-CLICK.md) and
[hardware preparation record](hardware/esp32/PREPARE-AND-FLASH.md).
The earlier [HTTPS sensor firmware](hardware/esp32/traceveil_dht22/README.md)
remains available for network-based capture.

## Architecture

```text
Batch evidence ───────────┐
Authenticated HTTP input ─┼─> Validated evidence / durable receipts
Local USB sensor input ──┘                │
                                         v
                              Canonical events + provenance
                                         │
                                         v
                         Deterministic detection, risk and correlation
                                         │
                                         v
                         Findings · Alerts · Incidents · Timelines
                         Device graphs · Charts · Analysis snapshots
                                         │
                                         v
                         React dashboard + SSE · PDF reports
                         Optional grounded local AI · Approved email
```

Both live transports feed the same normalization and investigation pipeline as
batch evidence. Browser views query persisted case records. Replay and recovery
refresh authoritative values, and pinned historical snapshots retain their scope.

| Layer | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS, Recharts, React Flow |
| Backend | Python 3.11+, FastAPI, Pydantic, Pandas, NetworkX |
| Persistence | SQLite, source/evidence storage and durable job receipts |
| Live input and delivery | Authenticated HTTP, PySerial USB adapter and replayable SSE |
| Reports and email | ReportLab PDF output and approval-gated SMTP |
| Optional AI | Ollama with the configured local Qwen model |
| Verification | Pytest, Vitest, generated OpenAPI types and firmware compilation |

## Local installation

For a fresh development checkout, install Python 3.11+, Node.js 20+, npm and Git.
A 64-bit computer with 16 GB RAM and SSD storage is the documented baseline;
24–32 GB RAM and an optional supported GPU help with local model inference.
Ollama, SMTP and physical hardware are optional for batch investigation.

From the repository root, create the environment file only if one is missing:

```powershell
if (-not (Test-Path backend\.env)) {
    Copy-Item .env.example backend\.env
}
```

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite forwards `/api` to the
backend. Health endpoints are `/api/v1/health`, `/api/v1/health/db` and
`/api/v1/health/ai` on port 8000.

For physical USB capture, prepare the local ESP32 toolchain and configure the
`esp32-lab-01` source in `LIVE_SOURCE_TOKENS` as described in the hardware guides.
Keep credentials in ignored local configuration, not in committed source files.

### Optional local AI

Install and start Ollama, pull the intended local model, and set its exact tag in
`backend/.env` as `OLLAMA_MODEL`. Use `ollama list` and **System Status** to check
availability. Core investigation remains usable when the model is offline.

### Reports and email

Create a case report, generate its PDF, review and approve it before export or
delivery. Email uses a separately editable and approved draft with a final
**Send** action. Alert and incident drafts can be created directly from their
record drawers. Simulation does not send email.

Configure the provider, sender, credentials, TLS option and allowed recipient
domains under **System Status → SMTP setup**. The last local check reported an
empty SMTP host and `configured=false`; real recipient delivery has **not** been
verified. Fake-SMTP tests verify approval, send behavior and delivery-state updates.
The app does not send alerts by email automatically or automatically retry an
uncertain delivery.

## Data and evaluation

The repository includes curated CASAS, TON_IoT, HAI ICS, IoT-23 and controlled
simulation workflows, with dataset descriptions, provenance and deterministic
expectations. Label-free evaluation distinguishes supplied dataset labels from
independently detected concerns. Large research datasets stay outside Git.

The physical demonstration used real sensor readings in Cases 8 and 9, with a
controlled authentication-failure simulation exercising `AUTH-001`. The simulator
uses its own `traceveil-simulator` source and `simulated-auth-*` device identities;
it does not claim that the DHT22 itself was compromised. Sensor accuracy was not
independently calibrated.

## Verification

Run the backend suite from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

Run frontend checks from `frontend/`:

```powershell
npm test
npm run lint
npm run build
```

The latest recorded focused runs passed 11 USB/configuration backend tests,
43 Live Monitor/setup frontend tests and 34 case-workspace/API-client frontend
tests, plus separate case-query, history/reanalysis, simulation and email
regressions. The production frontend build and USB firmware compilation passed;
the firmware was uploaded and both new-case and existing-case USB capture were
verified on the actual board. API JSON and generated types were synchronized.
Final documentation preflight passed all 155 frontend tests, the TypeScript
check and production build, plus the OpenAPI export check. App smoke tests were
aligned with the completed live-monitor and report interfaces. Backend full-suite
and integration acceptance are recorded by the final PR checks.

Real SMTP/inbox acceptance remains an operational follow-up. Full integration
checks and merge status are recorded on the final pull request into `main`. MQTT, multi-user authorization and external
job/storage infrastructure are possible extensions beyond this completed local
academic scope.

## Project documents

The three current project records live together in **[`docs/`](docs/)**:

| Record | File |
| --- | --- |
| Roadmap and acceptance checklist | [roadmap.md](docs/roadmap.md) |
| Completion report | [Completion_Report_2026-09-06.md](docs/Completion_Report_2026-09-06.md) |
| Team contributions | [Contributions.md](docs/Contributions.md) |

The completion report retains its original filename; its current update date and
source commit are recorded inside. Older DOCX handoffs remain historical exports.

- [USB one-click setup](hardware/esp32/USB-ONE-CLICK.md)
- [Physical hardware preparation and HTTPS acceptance](hardware/esp32/PREPARE-AND-FLASH.md)
- [Live scenario and historical-review demonstration](docs/phase3-live-demo.md)
- [Evidence validation contract](docs/contracts/evidence-validation.md)
- [Canonical event contract](docs/contracts/canonical-event.md)
- [Deterministic analysis contract](docs/contracts/deterministic-analysis.md)
- [Investigation API contract](docs/contracts/investigation-api.md)
- [Full project synopsis (DOCX)](docs/First%20Review%20synopsis/Traceveil_Full_Synopsis.docx)
- [Full project synopsis (PDF)](docs/First%20Review%20synopsis/Traceveil_Full_Synopsis.pdf)

## Scope and team

Traceveil is a local academic investigation prototype for owned or authorized
laboratory devices. Production fleet monitoring, arbitrary third-party network
interception, automated containment and legal-admissibility claims remain outside
its scope. Findings and AI narrative are visibly distinct, and external delivery
requires investigator approval.

- Atharva Rangnekar (K053)
- Aarya Rao (K054)
- Ayra Jha (K028)
- Project guide: Prof. Rohit Suryawanshi
