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

## Device connection state

Three states are published, all backend-authored: `online`, `stale` and
`offline`. `stale` means nothing has been accepted from the device within its
**own session's** `stale_after_seconds`, resolved from `live_sessions` rather
than the global default, so two sessions that declared different thresholds
transition at different times. `offline` means the device or its transport
last reported its link down; that check runs first, because a retained
transport message carries a fresh timestamp and a recency test alone would
render a disconnected sensor as Online. The browser distinguishes all three
and never infers any of them: with nothing being reported, the SSE heartbeat
is what triggers a refetch, so the transition from Online to Stale is a
backend decision the browser only displays. The legacy `stale` boolean is
retained and is true for both `stale` and `offline`.

## Reconnect recovery

Replay is bounded by `LIVE_STREAM_RETENTION` and
`LIVE_STREAM_RETENTION_HOURS`. If a client's `Last-Event-ID` is older than the
oldest retained message, the messages in between no longer exist, and
resuming silently would drop them from the feed with no signal. The endpoint
emits a versioned `stream.reset` control frame first instead, carrying
`reason: cursor_expired`, the oldest retained id, a resume cursor just before
it, and the list of authoritative resources to refetch. The browser discards
its display buffers and rebuilds devices, metrics, timeline, events and alerts
from the investigation and live APIs, so recovery restores true state rather
than patching a partial view.

`stream_id` is one global sequence and retention prunes it globally, so the
retained window is a global fact. The check is deliberately conservative:
pruning that removed only other cases' messages still reports a gap. The cost
is one unnecessary refetch of authoritative state; the alternative is
occasionally missing a real gap, which is not an acceptable trade for an
evidence feed.

Pausing the display is a display concern only. The SSE client is held for the
life of a case and session, with `paused` kept in a ref, so pausing never
tears down the connection and never resets the cursor - which means resuming
causes neither a replay of retained history nor an eventual duplicate once the
bounded seen-id cache rolls over. Only a change of case or session resets
cursor state, because only then does the cursor belong to a different scope.

## Live invalidation beyond Live Monitor

The case workspace subscribes to `timeline.updated` through the same
`useLiveInvalidation` hook as Live Monitor, so an investigator reading the
Timeline, Findings, Alerts, Incidents or Overview tab sees newly accepted live
results without navigating away and back. Two rules keep that safe. A
deliberately pinned historical snapshot is never replaced - no stream is
opened at all while one is pinned. And when a record drawer is open, the view
is not swapped underneath the investigator; a "New live results available"
action is offered instead. Out-of-order responses cannot regress the display:
each load aborts the previous request and discards any response that is no
longer the newest.

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
python scripts/run_pytest_cleanly.py --timeout 1200 -- -q
python export_openapi.py ..\frontend\src\api\openapi.json --check
```

From `frontend`:

```powershell
npm test -- --run
npx tsc -b
```

## Verification result

The Steps 7 and 11 completion run passed the complete backend suite (222 tests,
including 27 real-time tests) with a clean process exit and no leaked worker
threads, all 108 frontend tests, the TypeScript type-check, the production
build, and OpenAPI regeneration.

Twenty-seven backend tests cover Step 7 specifically:

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
- Device connection state: a silent device becomes `stale` on its own
  session's boundary and not before; two sessions with different declared
  thresholds transition at different times; a reported link loss renders
  `offline` despite a recent timestamp; a later valid event returns the device
  to `online`; and repeatedly re-deriving status leaves the forensic snapshot
  byte-identical.
- Reconnect recovery: a cursor inside retention is not a gap (a fresh
  connection at 0 included); a pruned cursor produces an explicit
  `cursor_expired` description naming the oldest retained id and a resume
  cursor; the wire carries `stream.reset` as the first frame in that case and
  ordinary delivery after it; a retained cursor produces no reset; a quiet
  case is not told it has a gap merely because another case produced the
  messages its cursor sits behind; and a reset leaves persisted records
  untouched.
- Forensic invariance: the four assertions described above.

Eleven frontend tests cover the browser half: the timeline renders from the
investigation API on load; a `timeline.updated` frame causes a refetch that
surfaces the new entry; duplicate stream ids are applied once; a dropped
connection reconnects carrying `Last-Event-ID`; `Online`, `Stale` and
`Offline` are rendered as three distinct states; an idle heartbeat refetches
device status; a `stream.reset` frame discards the display buffers and
rebuilds from the authoritative APIs; pausing and resuming the display opens
no second stream; the case Timeline refetches when live analysis lands; a
pinned historical snapshot opens no stream at all and is never replaced; and
an open record drawer is offered a refresh rather than having the view
replaced underneath it.

## Deferred acceptance

Physical-hardware acceptance of live delivery (observing a real ESP32 node
driving the browser view end to end) remains part of Step 12 and is not claimed
here. Delivery is verified against authenticated telemetry and the controlled
simulator.
