# Step 7 — Real-Time Event Delivery Verification

Step 7 delivers persisted live results to the browser as they are produced. It
does not introduce any new forensic value: everything the operator sees is
refetched from, or carried verbatim out of, already-persisted backend records.

## Transport decision

Server-Sent Events, not WebSocket. Delivery is strictly one-way
(backend → browser), so a bidirectional upgrade buys nothing; `Last-Event-ID`
gives replay-on-reconnect for free from a durable log; and SSE traverses proxies
as ordinary HTTP without an upgrade negotiation. The endpoint is
`GET /api/v1/live/stream`, filtered by `case_id`, optional `session_id`, and an
optional comma-separated `topics` list.

## Delivered boundary

- A durable `stream_messages` log backs delivery, bounded by
  `LIVE_STREAM_RETENTION` and `LIVE_STREAM_RETENTION_HOURS`. Reads are pure
  queries against that log; the stream never writes to what it reads.
- Six topics are published: `event.accepted`, `alert.created`,
  `device.updated`, `timeline.updated`, `metrics.updated`, and
  `session.updated`, plus a `heartbeat` keepalive on idle connections.
- `timeline.updated` is new in Step 7. It is emitted after each live
  re-analysis and carries **only** `case_id`, `analysis_id` and `entry_count` —
  never timeline entries. The browser must refetch
  `GET /api/v1/cases/{case_id}/timeline`, so the displayed chronology is always
  backend-authored and can never be assembled client-side from stream payloads.
- Dashboard metrics follow the same rule: `metrics.updated` triggers a refetch
  of `/live/metrics` rather than shipping counters the browser could drift from.
- Alerts are emitted once per alert per case, gated by `live_alert_first_seen`,
  so reconnects cannot manufacture duplicate alerts.
- The browser client retries with exponential backoff and jitter, resumes with
  `Last-Event-ID`, reports a terminal error for non-retryable 4xx responses
  (never hammering an unauthorised endpoint), and suppresses duplicate stream
  ids. Pausing the display queues frames without stopping backend capture.

## Forensic invariance

Real-time delivery is read-only by construction, and this is asserted rather
than assumed. Reading the stream repeatedly, replaying it from a mid-stream
`Last-Event-ID` cursor, and streaming over real HTTP all leave a byte-identical
snapshot of: the latest analysis run id, every analysis artifact payload, every
canonical event, live receipt and evidence-record count. Separately, a consumer
polling *during* ingestion does not perturb the result — the content-addressed
analysis engine resolves a post-stream recomputation to the very same
`analysis_id` (`reused_existing: true`).

## Verification commands

From `backend`:

```powershell
python -m pytest -q
python scripts/run_pytest_cleanly.py --timeout 600 -- -q
python export_openapi.py ..\frontend\src\api\openapi.json --check
```

From `frontend`:

```powershell
npm test -- --run
npx tsc -b
```

## Verification result

The Step 7 completion run passed the complete backend suite (175 tests,
including 16 new real-time tests) with a clean process exit and no leaked
worker threads, and all 96 frontend tests plus the TypeScript project build.

Sixteen backend tests cover Step 7 specifically:

- Timeline delivery: the signal is emitted, names the latest analysis run, its
  `entry_count` matches the persisted timeline artifacts, it carries no
  renderable chronology, and the refetch it triggers returns entries.
- The real HTTP surface: `GET /api/v1/live/stream` is exercised against a real
  uvicorn server (Starlette's `TestClient` cannot terminate an infinite SSE
  generator, so it would deadlock rather than verify anything). Asserted:
  `text/event-stream`, `id:`/`event:`/`data:` framing consistent with the
  envelope, unique increasing ids, idle heartbeats, topic filtering,
  `Last-Event-ID` resumption with no gap or duplicate, case scoping, and clean
  repeated connect/disconnect.
- Forensic invariance: the four assertions described above.

Four frontend tests cover the browser half: the timeline renders from the
investigation API on load, a `timeline.updated` frame causes a refetch that
surfaces the new entry, duplicate stream ids are applied once, and a dropped
connection reconnects carrying `Last-Event-ID`.

## Deferred acceptance

Physical-hardware acceptance of live delivery (observing a real ESP32 node
driving the browser view end to end) remains part of Step 12 and is not claimed
here. Delivery is verified against authenticated telemetry and the controlled
simulator.
