# Traceveil Roadmap

> Current software status (16 September 2026): 165 of 176 roadmap items are complete (93.8%). The persisted batch workflow, authenticated live intake, deterministic investigation APIs, curated evaluation datasets, classification transparency, case-analysis UX, safe message-linked visualization engine, grounded local-AI investigation chat, real-time browser delivery with backend-authored device state, scope-isolated reconnect recovery and order-guarded timeline refresh, and approval-gated alert, notification and reporting automation with atomic terminal auditing are implemented end to end through the connected interface. The 11 remaining items are confined to physical hardware acceptance.

## 1. Initialization
- [x] Set up React + Vite frontend
- [x] Set up FastAPI backend
- [x] Set up SQLite
- [x] Install required libraries
- [x] Connect frontend and backend
- [x] Add Ollama configuration and optional availability/model health checks
- [x] Install Ollama, pull the selected Qwen 9B Q4_K_M model, and verify it locally

**Current result:** Step 1 is complete. The Traceveil frontend connects to
FastAPI and reports API, SQLite, and Ollama health. Backend health tests pass (4
tests), and the frontend test suite passes (14 tests). Traceveil remains usable
when Ollama is offline.

## 2. Frontend and Investigation Interface
- [x] Build the initial Step 1 service-status shell
- [x] Build the global application layout and navigation
- [x] Build case pages
- [x] Build evidence upload/import page
- [x] Build main investigation dashboard
- [x] Add metric and severity cards
- [x] Add evidence tables
- [x] Add chart placeholders
- [x] Add incident timeline placeholder
- [x] Add device/entity graph placeholder
- [x] Add recommendations/findings panels
- [x] Add live monitoring status indicators
- [x] Add live event feed
- [x] Add live alert feed
- [x] Add device connection/status components
- [x] Add chat section
- [x] Add email/report sections
- [x] Use structured mock data before backend feature integration

**Current result:** Step 2 is complete. The frontend now provides the global
application shell, case workspaces, evidence import flow, investigation
dashboard, metrics, evidence tables, deterministic visualizations, timeline,
entity graph, findings, live-monitoring views, Investigation Assistant, and
report review experience. Persisted investigation views are connected to the
backend APIs; mock data remains limited to explicit demonstrations and tests.

## 3. Input Check and Evidence Validation
- [x] Accept supported evidence file types
- [x] Check file size and structure
- [x] Validate required columns
- [x] Detect missing or invalid values
- [x] Hash and store evidence metadata
- [x] Preserve source metadata
- [x] Return structured validation errors for later API/frontend integration
- [x] Define validated live telemetry input contracts
- [x] Validate incoming device identifiers and event types
- [x] Reject malformed live telemetry
- [x] Record live ingestion timestamps
- [x] Preserve source/device provenance for live evidence
- [x] Validate the pinned CASAS Milan CSV projection
- [x] Validate the pinned TON_IoT fridge telemetry subset
- [x] Require pytest to terminate cleanly in CI

## 4. Canonical Event Model and Normalization
- [x] Create the common canonical event schema
- [x] Map simulated data
- [x] Map CASAS Milan smart-home sensor data
- [x] Map TON_IoT fridge device telemetry
- [x] Retain TON_IoT network data as a secondary compatibility adapter
- [x] Retain CICIoT2023 network data as a secondary compatibility adapter
- [x] Standardize timestamps
- [x] Standardize device and entity fields
- [x] Preserve source row references
- [x] Create a live telemetry adapter
- [x] Normalize live device events into the canonical event model
- [x] Preserve live source and ingestion metadata

**Convergence point:** Uploaded/batch evidence and accepted live telemetry both
become canonical events and enter the same deterministic investigation pipeline.

**Selected evaluation sources:** CASAS smart-home telemetry and TON_IoT device
telemetry are the primary public datasets, supplemented by controlled simulation.
The existing TON_IoT network and CICIoT2023 adapters remain secondary
compatibility paths.

## 5. Live IoT Integration
- [x] Select the Arduino-compatible microcontroller
- [x] Select the IoT test device or endpoint
- [x] Define the controlled laboratory topology
- [x] Define the live telemetry message format
- [x] Implement device-to-backend telemetry transport
- [x] Support MQTT and/or HTTP based on the chosen implementation
- [x] Build the backend live event collector
- [x] Add device registration/identification
- [x] Add connection and heartbeat status
- [x] Store accepted live telemetry as evidence
- [x] Forward normalized live events into the common analysis pipeline
- [x] Prepare controlled suspicious-event scenarios for demonstration
- [x] Verify end-to-end live ingestion

**Current result:** Step 5 is complete for the authenticated HTTP laboratory
path. Accepted telemetry is identified, validated, persisted, normalized, and
processed through the common analysis pipeline. Physical showcase acceptance is
still tracked under Step 12.

## 6. Filtering, Detection, Risk and Correlation
- [x] Add deterministic filters
- [x] Add stable sorting
- [x] Add detection rules
- [x] Add behavioural baselines
- [x] Add bounded risk scoring
- [x] Add event correlation
- [x] Build incident timelines
- [x] Generate graph data
- [x] Generate chart-ready aggregates
- [x] Support analysis of both batch and live events
- [x] Trigger alerts from qualifying live events

**Current result:** Step 6 is complete. The backend provides a versioned
deterministic analysis service over canonical batch and live events. It returns
rule traces, baseline samples, bounded five-factor risk scores, explicit
correlation reasons, incident components, stable timelines, NetworkX graph
data, Pandas chart aggregates, and pending alerts for actual live triggers.
Golden and adversarial tests verify reproducibility, phase boundaries, missing
observed time, stable filtering, batch/live alert behaviour, label provenance,
blind anomaly detection, bounded incident grouping, and cross-source identity.
Derived artifacts are persisted and exposed through the Step 8 APIs; real-time
browser delivery remains Step 7.

## 7. Real-Time Event Delivery
- [x] Add backend real-time event delivery
- [x] Select SSE or WebSocket transport based on implementation needs
- [x] Stream accepted live events to the frontend
- [x] Stream generated alerts to the frontend
- [x] Update device status in near real time
- [x] Update timelines when relevant live events arrive
- [x] Update dashboard metrics from validated backend data
- [x] Handle temporary frontend/backend disconnections
- [x] Add safe reconnect behaviour
- [x] Ensure real-time delivery does not alter forensic calculations

**Current result:** Step 7 is complete. Persisted live results reach the browser
over Server-Sent Events at `/api/v1/live/stream`, backed by a durable, bounded
`stream_messages` log and filtered by case, session and topic. Six topics are
published alongside an idle heartbeat; the new `timeline.updated` signal carries
only a case id, analysis id and entry count, so the incident timeline and the
dashboard metrics are always refetched from validated backend records rather
than assembled in the browser. The client retries with exponential backoff and
jitter, resumes with `Last-Event-ID`, stops on non-retryable responses, and
suppresses duplicate stream ids; pausing the display never stops backend
capture. Delivery is read-only by construction and asserted to be so: repeated
reads, mid-stream replay, real HTTP streaming and a consumer polling during
ingestion all leave evidence, canonical events, analysis runs and every analysis
artifact byte-identical, with a post-stream recomputation resolving to the same
content-addressed `analysis_id`. The SSE endpoint is exercised against a real
uvicorn server rather than an in-process test client.

Device status distinguishes three backend-authored states. `stale` is decided by
the device's own session threshold rather than a global default, so sessions that
declared different thresholds transition at different times; `offline` is decided
by a reported link loss and is checked first, because a retained transport message
carries a fresh timestamp and a recency test alone would render a disconnected
sensor as Online. With nothing being reported, the SSE heartbeat drives a refetch,
so the transition is a backend decision the browser only displays.

Reconnect recovery is explicit. Three cursors the server cannot honour — one
retention has passed (`cursor_expired`), one naming ids never issued
(`cursor_ahead`), and one that cannot be parsed (`cursor_invalid`) — each produce
the same versioned `stream.reset` instruction with its own diagnostic code, so a
gap is never silent and a malformed header never becomes a 4xx the browser
retries against forever. Recovery is authoritative: every resource the reset
names is reloaded, including the persisted events and alerts, because clearing a
display buffer is not a rebuild.

Nothing crosses a case or session boundary. The shared hook drops its paused
queue whenever the case, session, active state or topic scope changes, and Live
Monitor clears its event, alert and seen-id buffers on the same change. A reset
is handled centrally and delivered even while paused, since a paused display
holding post-gap data is the failure it exists to prevent. Pausing is otherwise a
display concern only: the client is held for the life of a case and session with
`paused` in a ref, so pausing never tears down the connection or resets the
cursor, and causes neither replay nor eventual duplicates.

Live invalidation reaches the case workspace as well as Live Monitor through one
shared hook, and both converge on the newest persisted analysis: a
signal-triggered refresh asks for the exact `analysis_id` the signal named, and
every refresh additionally takes a monotonic sequence and aborts its predecessor,
with the sequence re-checked on resolution because a transport may ignore the
abort — so no response-order race can regress the displayed analysis and a
superseded refresh neither errors nor blanks the chronology. A pinned historical snapshot opens no
stream and is never replaced; an open record drawer is offered a refresh rather
than having the view swapped underneath it. Physical-hardware acceptance of live
delivery remains Step 12. See [the Step 7 verification](step-7-verification.md).

## 8. Dashboard Results and Investigation APIs
- [x] Create APIs for cases
- [x] Create APIs for evidence validation and retrieval
- [x] Create APIs for events
- [x] Create APIs for alerts
- [x] Create APIs for incidents
- [x] Create APIs for timelines
- [x] Create APIs for graphs and chart data
- [x] Connect real analytical results to the dashboard
- [x] Expose risk breakdowns through investigation APIs
- [x] Expose supporting evidence identifiers through investigation APIs
- [x] Expose provenance/source references through event APIs
- [x] Add refresh controls
- [x] Add reanalysis controls
- [x] Allow historical review of persisted batch analysis snapshots and incidents
- [x] Preserve the selected snapshot across result tabs and browser refreshes
- [x] Verify generated OpenAPI types and connected frontend workflows in CI
- [x] Document genuine live-incident history as deferred to Steps 5 and 7

**Current result:** Step 8 is complete for the persisted batch-investigation scope. Case-scoped endpoints
ingest and retrieve evidence, persist and filter canonical events, execute the
deterministic analysis engine, and return findings, alerts, incidents, timelines,
graphs, charts, provenance, risk factors, and historical analysis snapshots.
The React investigation views consume these persisted APIs through generated
OpenAPI types, expose manual refresh and safe idempotent reanalysis, and retain a
selected historical snapshot while navigating between analytical views. Mock and
live-shaped adapters remain explicit test/demo configuration only. End-to-end
genuine live ingestion, real-time delivery, and historical review of genuine live
incidents are acceptance dependencies of Steps 5 and 7, not Step 8.

## 9. Visualization Engine + Qwen
- [x] Create allowed visualization components
- [x] Create and validate versioned layout JSON
- [x] Allow only deterministic data references
- [x] Let Qwen summarize validated results
- [x] Let Qwen choose safe visualization layouts
- [x] Reject unknown components and fields
- [x] Reject invented numerical values
- [x] Reject unsafe output
- [x] Add deterministic fallback layouts
- [x] Support visualization of both historical and live investigation data
- [x] Offer a focused analysis set: timeline, event activity, top entities, severity mix, entity relationships, and top findings
- [x] Route Automatic mode deterministically from the investigation question
- [x] Pin each response visual to the analysis snapshot used for that message
- [x] Reopen visuals from older chat responses without showing stale canvas data
- [x] Preserve legacy saved layouts while hiding superseded table and factor views from new selections

**Current result:** Step 9 is complete. New Assistant responses use a focused
set of six analysis views: investigation timeline, event activity, top entities,
severity mix, entity relationships, and ranked top findings. Automatic mode
maps question intent to one of those server-owned layouts; Qwen supplies concise
narration but never creates datasets or executable UI. Layouts contain pinned
deterministic references, and the backend resolves bounded persisted results for
the frontend. Unknown fields, components, versions, unsafe strings, embedded
data, invented numerical claims, and out-of-scope references are rejected.
Message-linked visuals can be reopened from history without stale-canvas
leakage. Superseded risk-factor, evidence-table, and alert-table layouts remain
resolvable only for backward compatibility with saved conversations.

## 10. AI Investigation Chat
- [x] Add case-based chat
- [x] Answer questions using selected evidence
- [x] Explain alerts
- [x] Explain risk scores
- [x] Explain correlations
- [x] Explain live incident sequences
- [x] Return evidence references
- [x] Save chat history
- [x] Handle Qwen being offline
- [x] Separate normal conversation from evidence-grounded investigation mode
- [x] Respond naturally to greetings and ordinary questions without retrieving case evidence
- [x] Resolve explicit case names before cross-case retrieval
- [x] Add independent AI-generation and Ollama runtime controls in System Status
- [x] Show model, installation, context-window, request-budget, and availability details
- [x] Bound recent conversation context and model output for faster responses
- [x] Fix durable history restoration, scrolling, cancellation, retry, and per-message visual state

**Current result:** Step 10 is complete. Assistant sessions validate case and
selected-record scope, persist messages and jobs, derive useful conversation
titles, and can be listed and reopened reliably. A visible evidence toggle keeps
normal chat separate from grounded investigation retrieval, so greetings and
ordinary questions receive natural AI responses instead of unrelated case
fallbacks. Explicit case names are resolved before cross-case retrieval. Grounded
answers use bounded persisted facts and verified citations; unsafe content,
unknown references, and invented numerical claims are rejected. System Status
now controls AI generation and the Ollama runtime independently and reports the
installed model plus active context/request limits. Short recent history,
bounded prompts and outputs, model keep-alive, and deterministic layout selection
reduce latency. The interface restores useful chat history, handles long-message
scrolling and jump-to-latest behavior, supports cancellation/retry, and binds
visuals to their originating response. Offline or invalid model output still
completes with a clearly labelled deterministic explanation.

## 11. Alerts, Email, Reports and Automation
- [x] Add SMTP setup
- [x] Generate alert email drafts
- [x] Support drafts for live detected incidents
- [x] Require investigator approval before sending
- [x] Add report export
- [x] Auto-run analysis after batch upload
- [x] Automatically process validated incoming live events
- [x] Auto-group related alerts
- [x] Create deterministic incident summaries before AI narration
- [x] Preserve alert and notification audit history

**Current result:** Step 11 is complete. Every incident now carries a
backend-authored `summary` assembled only from the deterministic engine's own
severity, risk, counts and observed window, produced before any model is
consulted and reproduced byte for byte on recomputation; the exported report
renders those summaries above the AI narrative, which is labelled
non-authoritative, and the connected incident table and drawer surface the
summary rather than burying it among raw fields.

Notification drafts are subject-agnostic: they may be raised against an approved
report as before, or directly against a deterministic alert or incident with no
report required and no PDF attached, which makes them usable while an
investigation is still live. The backend writes the draft — only a recipient is
required, and the initial subject and body are composed from the persisted
artifact, reproducing an incident's deterministic summary verbatim and stating no
value the artifact does not already carry, with a preview endpoint so an
investigator reads the text before any record exists. Unknown and cross-case
identifiers are refused. A shared panel in the alert and incident drawers carries
the whole create, edit, approve and send path, and drafts are listable so one
awaiting approval is reopened rather than duplicated after a refresh.

The lifecycle is fully auditable: edits record which fields changed and whether an
approval was revoked without republishing the message, and refused sends record a
bounded reason code. A terminal outcome is atomic — the delivery attempt, the
draft's terminal state, the alert's `notification_status` and the terminal audit
record commit in one transaction, so no completed delivery can exist without its
audit history, and a failing audit insert rolls the whole delivery back rather
than leaving it recorded without evidence. An incident notification deliberately leaves individual
alerts alone rather than overstating what was sent. The `email_drafts` migration
that relaxes `report_id` rebuilds the table inside one transaction with foreign
keys verified before commit and restored in a `finally` path, and is covered by
dedicated legacy-database regression tests including a forced mid-rebuild failure.

The completion run passed the full backend suite (232 tests, including 33 Step 11
tests and 8 migration tests) with a clean process exit and no leaked worker
threads, the OpenAPI contract check, all 120 frontend tests, the TypeScript
type-check, and the production build. See `docs/step-11-verification.md`.

## 12. Physical Live Demonstration
- [ ] Assemble the Arduino and IoT laboratory setup
- [ ] Verify normal device telemetry
- [ ] Verify live dashboard updates
- [ ] Execute a controlled simulated suspicious scenario
- [ ] Confirm the detection rule triggers
- [ ] Confirm a live alert appears
- [ ] Confirm the event is persisted as evidence
- [ ] Confirm the incident timeline updates
- [ ] Confirm device/entity relationships are visible
- [ ] Confirm the captured incident can be investigated after the live event
- [ ] Document the complete demonstration procedure

## 13. Dataset Intelligence, Classification Transparency, and Analysis UX

**Owner:** J3DI

**Status:** Complete in `c4ec731` and `42efe68`

- [x] Create one discoverable dataset catalog — **J3DI**
- [x] Curate practical HAI, IoT-23, TON_IoT, CASAS, and simulation samples — **J3DI**
- [x] Add small schema-contract fixtures and dataset checksums — **J3DI**
- [x] Document physical devices, canonical identities, and camera involvement — **J3DI**
- [x] Retain reproducible sample-building tools while excluding bulky full archives — **J3DI**
- [x] Add label-free HAI ICS and IoT-23 validation profiles — **J3DI**
- [x] Normalize common attack labels into a stable classification taxonomy — **J3DI**
- [x] Record whether classification came from a dataset label, deterministic rule, or behavioural anomaly — **J3DI**
- [x] Keep source-supplied labels separate from Traceveil-discovered findings — **J3DI**
- [x] Detect wide-telemetry baseline and rate-of-change anomalies — **J3DI**
- [x] Detect unusual network fan-out, destination-port fan-out, and connection-failure bursts — **J3DI**
- [x] Include classification and evidence confidence in explainable risk scoring — **J3DI**
- [x] Split dense findings into bounded, time-aware incident sessions — **J3DI**
- [x] Prevent analysis-artifact identifier collisions during large imports — **J3DI**
- [x] Persist activity-window anomaly attribution and unknown-cause explanations — **J3DI**
- [x] Correlate mixed datasets only through genuine time, device, or network context — **J3DI**
- [x] Page dense timelines and lazily load expanded minute records — **J3DI**
- [x] Prevent blank/stale timeline content during client-side navigation — **J3DI**
- [x] Add classification, risk, incident, entity, and spike-attribution explainers — **J3DI**
- [x] Generate beginner-friendly descriptions for single- and multi-dataset cases — **J3DI**
- [x] Keep case rows concise and show the full explanation in Case Overview — **J3DI**

**Current result:** Step 13 is complete. Traceveil can evaluate label-free
industrial and IoT network records, distinguish supplied answers from its own
detections, group dense results safely, explain timeline activity, converge
genuinely related sources, and tell a non-specialist what each case contains.
