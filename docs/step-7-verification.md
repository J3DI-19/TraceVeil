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
`LIVE_STREAM_RETENTION_HOURS`, so a resumption cursor is not always one the
server can honour. Three cases are refused, each with the same versioned
`stream.reset` instruction — refetch these resources, resume from this cursor —
and its own diagnostic code:

- `cursor_expired` — retention has already passed the cursor, so the messages
  between it and the oldest retained one no longer exist.
- `cursor_ahead` — the cursor names ids the server never issued, which happens
  when a client resumes against a rebuilt or rolled-back log. Resuming would
  leave the stream silent indefinitely rather than fail, because no future id
  ever reaches that cursor.
- `cursor_invalid` — the `Last-Event-ID` header could not be parsed. The header
  is read as a string and parsed in the endpoint rather than typed as an
  integer, so a malformed value produces this instruction instead of a 422 the
  browser's reconnect loop would retry against forever. A client carrying an
  unreadable cursor believes it has history, so treating it as a fresh
  connection would silently replay.

Recovery is authoritative, not cosmetic. Every resource named by
`resynchronize` is actually reloaded: devices, metrics and timeline, **and the
persisted events and alerts**. The live feeds are display buffers assembled
from stream frames, so after a gap the only way to show a true feed is to read
what the backend kept — clearing the buffers would leave an empty panel and no
indication anything had been missed. The reset payload itself carries
identifiers only.

`stream_id` is one global sequence and retention prunes it globally, so the
retained window is a global fact. The expired check is deliberately
conservative: pruning that removed only other cases' messages still reports a
gap. The cost is one unnecessary refetch of authoritative state; the
alternative is occasionally missing a real gap, which is not an acceptable
trade for an evidence feed.

## Recovery reads a query the API accepts

Reset recovery rebuilds its feeds from the investigation API, so the request it
issues has to be one that API will answer. Two things were wrong and are now
separated explicitly:

- **Display capacity is not a page size.** `MAX_EVENTS` (500) is how many
  records the browser will hold; `EVENT_PAGE_SIZE` (200) is what one request may
  ask for, which is the endpoint's own ceiling. Passing the display bound as the
  page size returned 422 on every recovery, so nothing was rebuilt while the UI
  reported a successful authoritative rebuild. The two are now distinct
  constants, and the backend limit is asserted from the backend side so it
  cannot be widened to match a browser buffer instead.
- **Recovery says which records it wants.** The events and artifact endpoints
  gained an `order` parameter (`asc` by default, so no existing caller changes;
  a closed `Literal`, never interpolated text). Recovery asks for `desc`:
  ascending page 1 is the oldest history of the case, not the feed the operator
  was watching. Expressing that in the contract keeps the selection
  backend-authored rather than having the browser guess which page holds
  "recent".

Recovery reads one bounded page per resource — the most recent 200 events and
100 alerts, case-wide. A failed reload is reported as a failed reload: an empty
or partial panel is never presented as a completed rebuild.

## Snapshot and stream compose, they do not replace

A reset starts an asynchronous snapshot request but leaves the stream
connected, so a newer event or alert can arrive before the response lands.
Replacing the feed with the snapshot erased a record the backend had already
delivered: the investigator watched an alert appear and vanish while the stream
cursor had moved past it. The persisted evidence was never at risk; what was
lost was sight of it, which during a live incident is the thing that matters.

Records streamed during a recovery are now displayed immediately **and**
retained in a bounded per-recovery buffer. When a snapshot succeeds it is
merged with that buffer, keyed by the authoritative `event_id` / `alert_id`,
with the streamed representation winning for an id present in both — it is the
later view of the same record. Ordering uses backend timestamps with the
identifier as a stable tiebreak; the browser never invents a forensic time.
The display bound is applied after the merge, and only the completed
recovery's collection is cleared, so a stale response cannot empty the active
one. Retention stops once a resource's snapshot has landed: records arriving
afterwards are ordinary live feed, and continuing to buffer them would let a
busy stream report an overflow against a recovery that had already finished. Every buffer dies with its scope, and an overflowed buffer is reported
and re-run once rather than quietly presented as complete.

Recovery scope is unchanged and deliberate: one bounded case-wide page, the
most recent 200 events and 100 alerts. The snapshot does not claim to refill
the 500-slot display buffer.

## Recovery status is truthful

The reset notice used to say "refetched authoritative state" before the
requests had returned, pairing a completion message with work still in flight;
a stalled request left an incomplete panel looking finished. Each of the five
resources — devices, metrics, timeline, events, alerts — now reports its own
outcome, and the banner is derived from them: **pending** while any request is
outstanding, **complete** only when all five succeed, **partial** when some
fail or the buffer overflowed, **failed** when none succeed. Partial and
failed offer a retry. A result from an old scope or a superseded recovery
cannot move the status.

The obligation to report a resource belongs to the **recovery**, not to any
one request. A `timeline.updated` frame arriving mid-rebuild aborts the
recovery's own timeline request and starts a newer one; if that obligation
died with the aborted request, the rebuild would sit on "Still loading:
timeline" indefinitely while the newest chronology was already on screen. It
transfers to whichever request is now live instead, and is never satisfied by
the abort itself - only a request that actually answers can settle it.

## Scope-guarded responses

Clearing a buffer does not cancel a request already in flight. A Case A response
that resolves after the operator switched to Case B would otherwise be applied
on arrival, attributing one case's alerts to another — in an investigation tool
that is a correctness failure, not a flicker.

Every loader now captures the scope it was issued under and re-checks it before
any state write, and before any error write. Three checks, because each catches
something the others do not:

- the **abort signal** — the normal path, when the transport honours cancellation;
- the **generation** — the final boundary, for transports, API wrappers and test
  doubles that ignore cancellation and deliver the promise anyway;
- the **recovery sequence** — for two refreshes inside the *same* scope, where
  the scope check passes for both and only ordering separates them.

Changing case or session bumps the generation, aborts everything outstanding and
clears the buffers before any new request begins; unmounting does the same. Every
path uses the same loaders — initial load, heartbeat, metrics signal, timeline
signal, reset and resume — so none of them can bypass the rule.

The stream callbacks are gated the same way. Dropping the paused queue when the
scope changes is not sufficient on its own: a frame read from the *previous*
stream can be dispatched after the new scope's effect has already run, and the
queue is one ref shared across scopes, so that frame would be buffered under the
new scope and flushed into it on resume. Every callback therefore checks its own
effect's abort signal first, which makes a superseded stream inert rather than
letting its late frames be re-homed.

## Scope isolation

Nothing crosses a case or session boundary. `useLiveInvalidation` drops the
paused queue whenever the case, session, active state or topic scope changes —
on entry and on exit, not only on unmount — and Live Monitor clears its event,
alert and seen-id buffers on the same change. Without that, a frame buffered
while paused on one case would flush into another's display on resume, and the
previous scope's seen ids would keep suppressing the new scope's frames as
duplicates.

`stream.reset` is handled centrally in the hook and delivered immediately even
while the display is paused: a paused display holding post-gap data is the
failure the signal exists to prevent. Anything queued behind a reset predates
the gap, so it is discarded rather than replayed.

Pausing the display is otherwise a display concern only. The SSE client is held
for the life of a case and session, with `paused` kept in a ref, so pausing
never tears down the connection and never resets the cursor — which means
resuming causes neither a replay of retained history nor an eventual duplicate
once the bounded seen-id cache rolls over.

## Timeline refresh ordering

Live analysis can emit several `timeline.updated` frames in quick succession.
Both screens converge on the newest persisted analysis under two rules.

First, a refresh triggered by a signal asks for the **exact snapshot the signal
named**, by `analysis_id`, which the timeline API accepts. That is stronger than
asking for "latest" twice and sorting the answers out afterwards: two requests
for latest can legitimately return different analyses, and only arrival order
would distinguish them.

Second, a sequence guard still applies, because a refresh with no analysis id —
a heartbeat, a reset, a resume, the initial load — has nothing to pin. Each
refresh takes a monotonically increasing sequence number and aborts the request
before it, and the sequence is re-checked on resolution because a transport or a
test double may ignore the abort. A superseded request is ordinary operation,
not a fault: it neither surfaces an error nor blanks the chronology. In Live
Monitor every refresh path goes through the one guarded function, so no path can
bypass either rule.

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

The completion run passed the complete backend suite (243 tests, including 33
real-time tests and 10 recovery-contract tests) with a clean process exit and no leaked worker threads, all
143 frontend tests, the TypeScript type-check, the production build, and the
OpenAPI contract check.

The contract changed in exactly one place: the `Last-Event-ID` header is now a
string so a malformed cursor can be answered with a reset instead of a 422.
Types were regenerated accordingly.

Thirty-three backend tests cover Step 7, plus eight contract tests:

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
- Cursor handling: a retained cursor is not a gap (a fresh connection at 0
  included); a pruned cursor, a cursor ahead of the log and an unparseable
  header each produce their own diagnostic code with the same reset
  instruction, over the service API and over real HTTP; a quiet case is not
  told it has a gap merely because another case produced the messages its
  cursor sits behind; the persisted events and alerts a recovery reads back are
  asserted to exist; and a reset leaves persisted records untouched.
- Forensic invariance: reading, re-reading and replaying the stream leave
  evidence, canonical events, analysis runs and every analysis artifact
  byte-identical.
- Resilience: one unreadable `latest_metrics_json` blob degrades that device to
  an empty reading instead of faulting the whole listing.
- Recovery contract (`test_recovery_query_contract.py`): `page_size=200`
  succeeds while 201 and 500 are refused, for both events and alerts; the
  default order is still ascending; `desc` returns the same records newest
  first; a bounded page returns the newest records rather than the oldest; an
  unknown or injected `order` is refused and the table survives; and empty,
  under-a-page and exactly-one-page recoveries all answer without duplicates.

Thirty-eight frontend tests cover the browser half. Beyond the delivery and
device behaviour already described: every reset-triggered request uses a page
size the API accepts and asks for `order=desc`; a refused reload reports a
failed reload rather than an empty rebuild; delayed responses from the previous
case are discarded for events, alerts, devices and metrics alike; a stale
rejection raises no notice against the case that replaced it; a response from a
previous live session on the same case is discarded; an older recovery that
resolves after a newer one does not win; outstanding requests are inert after
unmount and the page still works afterwards; an event and an alert streamed
while their snapshot was loading both survive it; an id present in both the
snapshot and the stream renders once, in its streamed representation; a
superseded snapshot cannot merge into the newer recovery; the banner never
claims success while a request is pending; a failed resource reports a partial
rebuild and offers a working retry; and changing case mid-rebuild drops the
status and the records entirely.

A failed rebuild is reported as failed rather than partial; a recovery buffer
overflow is reported and rebuilds again exactly once; and a reset that reaches a
paused view composes with the frames queued behind it when the display resumes.

Every one of these was verified to fail against the behaviour it replaces:
reverting the page size fails 3 tests, disabling the scope guard fails 9,
replacing the merge with the snapshot fails 3, claiming success while pending
fails 2, collapsing failed into partial fails 1, never flagging overflow fails 1, and
letting a superseding timeline request drop the recovery obligation fails 1.

The test transport rejects on abort, the way a real one does. Holding a
response without honouring cancellation hides every defect in supersession
handling - which is how a permanently stuck recovery status reached review
under a suite that was otherwise green.

## Deferred acceptance

Physical-hardware acceptance of live delivery (observing a real ESP32 node
driving the browser view end to end) remains part of Step 12 and is not claimed
here. Delivery is verified against authenticated telemetry and the controlled
simulator.
