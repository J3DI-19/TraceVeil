# Step 11 — Alerts, Email, Reports and Automation Verification

Step 11 completes notification and reporting automation over the deterministic
engine that Phase 3 already delivered. It adds no new detection logic: every
notification and every report sentence is assembled from records the backend had
already persisted and hashed.

## Starting position

Seven of the ten Step 11 items were already implemented and covered by the
existing suite: SMTP configuration and delivery, investigator approval before
sending, report export, automatic analysis after batch upload, automatic
processing of validated live events, alert grouping into incidents, and the
alert/notification audit trail. Three were not:

- **Generate alert email drafts** — drafts could only be raised against a
  report.
- **Support drafts for live detected incidents** — same limitation.
- **Create deterministic incident summaries before AI narration** — incidents
  carried counts and bounds but no backend-authored prose, and the report placed
  the AI narrative first.

## Delivered boundary

- Every incident carries a `summary`: a single backend-authored sentence built
  only from the deterministic engine's own figures — highest severity, maximum
  risk out of 100, finding/alert/entity/evidence counts, and the observed time
  window. It is produced inside `correlation.build_incidents`, before any model
  is consulted, and is bounded to 1024 characters. It contains no model output,
  so it stands whether or not Ollama is reachable.
- Because the summary is a pure function of the grouped findings, recomputing an
  analysis reproduces it byte for byte. It is part of the content-addressed
  incident artifact, so a changed summary means a changed incident.
- The report renders `DETERMINISTIC INCIDENT SUMMARIES` **above**
  `AI NARRATIVE (NON-AUTHORITATIVE)`. A reader meets the authoritative account
  first, and the narrative can only annotate it.
- Notification drafts are now subject-agnostic. A draft may be raised against an
  approved report (as before), or directly against a deterministic **alert** or
  **incident** via
  `POST /api/v1/cases/{case_id}/alerts/{alert_id}/email-drafts` and
  `POST /api/v1/cases/{case_id}/incidents/{incident_id}/email-drafts`.
- **The backend writes the draft.** Only a recipient is required. The initial
  subject and body are composed from the persisted artifact - for an alert: its
  id, rule, title, severity, risk score, trigger time, finding and bounded
  evidence identifiers; for an incident: its deterministic summary reproduced
  verbatim, plus severity, maximum risk, observed window and counts. No model is
  consulted, and no value appears that the artifact does not already state, so a
  draft cannot describe something the deterministic engine never concluded.
  `GET .../notification-preview` returns that same text before any record is
  written, so an investigator reads what will be stored rather than approving
  text they cannot see. Supplied `subject`/`body` override the composed halves.
- Cross-case and unknown identifiers are refused: an artifact is resolved within
  its own case's latest analysis run, so an alert id from another case is a 404
  rather than an anchor to something the recipient's case never produced.
- Artifact-bound drafts need no report and attach no PDF, which is what makes
  them usable while an investigation is still live. Everything else is
  unchanged: the recipient domain allow-list, investigator approval before
  sending, content-hash pinning, send idempotency, and the audit trail all apply
  identically to all three subject types.
- Drafts are listable by case and by artifact
  (`GET /api/v1/cases/{case_id}/email-drafts`), so one awaiting approval is
  reopened after a refresh rather than duplicated.
- Approval is pinned to a hash over the recipient, subject, body **and** the
  subject artifact's own content hash. Editing a draft, or re-analysis that
  changes the underlying alert or incident, invalidates the approval and the
  send is refused.
- The `report_hash` key is retained in the hash preimage for report-bound
  drafts, so approvals recorded before Step 11 remain valid. Artifact drafts use
  `subject_hash`.
- `approved_report_required` is enforced only for report-bound drafts. Report
  delivery still refuses to send until the report itself is approved.

## Connected workflow

A shared notification panel appears in the alert and incident detail drawers of
the case workspace. It lists existing drafts for that artifact, previews the
text Traceveil will write, and carries the full create → edit → approve → send
path. The panel never composes notification text itself; it renders what the
backend wrote. An unsaved edit disables approval, because approval is pinned to
the stored content hash and approving unsaved text would pin the wrong content.
A sent notification is locked against editing and resending.

The deterministic incident summary is also surfaced where it is read: it leads
the incidents table and appears as a highlighted line at the top of the incident
drawer, rather than only inside the raw persisted-fields list.

## Notification lifecycle

Every decision that changes, blocks or completes a notification is now recorded:

- `email_draft.updated` on an edit, naming which fields changed, the previous
  and new content hashes, and whether an approval was revoked. The field
  **names** are recorded, never the new values - an edit must be
  reconstructible without republishing the message.
- `email.rejected` on a refused send or approval, carrying a bounded reason code
  from a closed vocabulary (`approved_email_required`, `email_content_changed`,
  `approved_report_required`, `smtp_not_configured`,
  `recipient_domain_not_allowed`, `sent_email_immutable`, `artifact_not_found`,
  `unsupported_draft_subject`) plus the request id. A silent refusal is the
  failure mode that matters here: without a record, an investigator who believes
  a notification went out has nothing saying why it did not. A raw exception
  string can never reach the audit details.
- A terminal delivery outcome is mirrored onto the alert it concerns:
  a successful send sets `notification_status` to `delivered`, an uncertain one
  to `delivery_failed` with a truncated reason.
- **The terminal audit record commits with the state it describes.** The
  delivery attempt, the draft's terminal state, the alert's notification status
  and the `email.sent` / `email.delivery_unknown` audit row are written in one
  transaction. Auditing after the commit leaves a window in which a completed
  delivery can exist with no history of it — which is the one thing an audit
  trail must never allow. A dedicated `_audit_locked` helper writes the row
  inside the caller's transaction; the ordinary `audit` helper is not used here
  precisely because it opens its own, which would commit the other three rows
  early and reintroduce that window. (`repository.write_lock` is an `RLock`, so
  nesting the lock was never the problem — the nested transaction was.)
  Delivery-attempt details stay bounded to identifiers, a message id and the
  list of alert ids synchronised: never a recipient, a message body, an
  attachment or an SMTP transcript.
- An **incident** notification deliberately leaves alert rows alone. An incident
  concerns a group, and marking each alert in it individually notified would
  overstate what was actually sent.

## Storage migration

`email_drafts` gains `subject_type` (default `report`), `subject_id`, `case_id`,
and its `report_id` becomes nullable. The additive part follows the
repository's established pattern — `PRAGMA table_info` plus `ALTER TABLE ADD
COLUMN` — then legacy rows are backfilled as report-bound and recover their
`case_id` from the report they belong to, so an old draft still appears in its
case's draft list instead of disappearing from the UI.

Dropping the `NOT NULL` on `report_id` is not expressible as an ALTER in
SQLite, so the table is rebuilt once, only when the old constraint is still
present. That table holds investigator approvals and delivery history, none of
which can be reconstructed from anything else, so two properties matter more
than speed:

- **Atomicity.** The copy, drop and rename run inside one explicit transaction.
  A failure at any point rolls back to the legacy table with every row, hash
  and approval intact, and the scratch table is removed so a later attempt
  starts clean. `executescript` is deliberately not used: it commits any open
  transaction before it runs, which would defeat exactly that guarantee.
- **Foreign keys.** Enforcement is disabled for the rename (the pragma is a
  no-op inside a transaction, so it is toggled outside one),
  `PRAGMA foreign_key_check` verifies the result before the commit, and
  enforcement is restored in a `finally` path so no failure can leave the
  connection unprotected.

Both halves are idempotent: a second `initialize()` finds the columns present
and the constraint already gone, and does nothing.

## Verification commands

From `backend`:

```powershell
python scripts/run_pytest_cleanly.py --timeout 1200 -- -q
python export_openapi.py ..\frontend\src\api\openapi.json --check
```

From `frontend`:

```powershell
npm run api:types
npm run lint
npm test
npm run build
```

## Verification result

The completion run passed the complete backend suite — **232 tests, including
33 Step 11 tests and 8 dedicated migration tests** — with a clean process exit
(exit code 0) and no leaked worker threads, plus the OpenAPI contract check,
all 120 frontend tests, the TypeScript type-check, and the production Vite
build.

The CI pytest deadline is 1200s and the job budget 25 minutes. The full suite
runs in roughly 500s locally; the Step 11 alerting and Step 7 device-state
tests drive real authenticated telemetry through the worker in order to raise
genuine artifacts rather than seeding fixtures.

The backend tests cover:

- **Deterministic summaries** — every grouped incident has one; its figures
  agree with the incident's own `maximum_risk`; recomputing the analysis
  reproduces identical summaries; and no summary contains model output or
  model-unavailable error text.
- **Report ordering** — the exported PDF contains both headings and the
  deterministic section precedes the AI narrative. The assertion decodes the
  PDF's ASCII85/Flate content streams rather than searching raw bytes, because
  the report canvas is written with `pageCompression=1`.
- **Grounded composition** — a draft created from a recipient alone states the
  alert's own persisted facts; an incident draft reproduces the deterministic
  summary verbatim; every number in a composed body is traceable to the
  artifact or the case, so invented figures fail the test; the preview matches
  the stored draft byte for byte; and investigator-supplied text overrides only
  the half it replaces.
- **Identity** — unknown and cross-case artifact identifiers are refused with
  404.
- **Approval gates** — sending an unapproved artifact draft is refused; editing
  an approved draft revokes the approval; a recipient outside the allow-list is
  refused.
- **Atomic terminal state** — forcing the terminal audit insert to fail rolls
  back the delivery attempt, the draft's terminal state and the alert's
  notification status together, leaving the draft approved and re-sendable
  rather than recorded as delivered without evidence. A successful delivery
  commits exactly one attempt, one terminal draft state, one synchronised alert
  status and one audit event; an uncertain delivery commits its failed
  counterparts exactly once; a repeated send adds none of them and transmits
  nothing; and the terminal audit's details carry only identifiers, a message
  id and the synchronised alert ids.
- **Lifecycle** — edits are audited without exposing the new subject or body;
  refused sends append a bounded reason code that never contains the recipient
  address; an incident notification leaves individual alerts `not_requested`.
- **Listing** — drafts are listable by case and filterable by artifact.
- **Migration** — a pre-Step-11 database migrates with every column, hash,
  approval timestamp, report relationship and delivery record intact; the
  legacy row is backfilled as report-bound and recovers its case; `report_id`
  becomes nullable and an alert draft with no report can then be stored;
  `initialize()` is idempotent across two runs; foreign keys are enforced and
  consistent afterwards; no scratch table survives; and a rebuild that fails
  partway rolls back to the legacy table with approvals intact, leaves no
  scratch table, and can be retried successfully.

Five frontend tests cover the notification panel: a draft is created from a
recipient alone with no browser-authored text in the request; an existing draft
is reopened rather than duplicated; an unsaved edit blocks approval and an
unapproved draft blocks sending; a refused send surfaces as an error rather
than as success; and a sent notification is locked.

## Deferred acceptance

Delivery is verified against a monkeypatched SMTP transport, as elsewhere in the
suite; no message leaves the test process. Acceptance against a real mail server,
and against alerts raised by physical ESP32 hardware, belongs to Step 12 and is
not claimed here.
