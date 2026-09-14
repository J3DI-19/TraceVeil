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
- Artifact-bound drafts need no report and attach no PDF, which is what makes
  them usable while an investigation is still live. Everything else is
  unchanged: the recipient domain allow-list, investigator approval before
  sending, content-hash pinning, send idempotency, and the audit trail all apply
  identically to all three subject types.
- Approval is pinned to a hash over the recipient, subject, body **and** the
  subject artifact's own content hash. Editing a draft, or re-analysis that
  changes the underlying alert or incident, invalidates the approval and the
  send is refused.
- The `report_hash` key is retained in the hash preimage for report-bound
  drafts, so approvals recorded before Step 11 remain valid. Artifact drafts use
  `subject_hash`.
- `approved_report_required` is enforced only for report-bound drafts. Report
  delivery still refuses to send until the report itself is approved.

## Storage migration

`email_drafts` gains `subject_type` (default `report`), `subject_id`, `case_id`,
and its `report_id` becomes nullable. The migration follows the repository's
established pattern — `PRAGMA table_info` plus additive `ALTER TABLE ADD
COLUMN`, then a backfill of legacy rows. Dropping the `NOT NULL` on `report_id`
requires a table rebuild, which is performed once, under
`PRAGMA foreign_keys=OFF`, only when the old constraint is still present.
Existing drafts keep their identifiers, hashes and approvals.

## Verification commands

From `backend`:

```powershell
python scripts/run_pytest_cleanly.py --timeout 600 -- -q
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

The Step 11 completion run passed the complete backend suite — **189 tests,
including 14 new Step 11 tests** — with a clean process exit (exit code 0) and
no leaked worker threads, plus the OpenAPI contract check, all 96 frontend
tests, the TypeScript type-check, and the production Vite build.

The CI pytest deadline is raised from 420s to 600s and the job budget from 10 to
15 minutes. The full suite runs in roughly 270s locally; the Step 11 alerting
tests drive ten authenticated live telemetry submissions per case through the
real worker in order to raise a genuine AUTH-001 alert rather than a fixture.

The fourteen backend tests cover:

- **Deterministic summaries** — every grouped incident has one; its figures
  agree with the incident's own `maximum_risk`; recomputing the analysis
  reproduces identical summaries; and no summary contains model output or
  model-unavailable error text.
- **Report ordering** — the exported PDF contains both headings and the
  deterministic section precedes the AI narrative. The assertion decodes the
  PDF's ASCII85/Flate content streams rather than searching raw bytes, because
  the report canvas is written with `pageCompression=1`.
- **Alert drafts** — a draft is created against a live alert with no report in
  the case at all; an unknown alert id is rejected with 404.
- **Incident drafts** — a draft is created against a live incident, carrying the
  incident's own content hash.
- **Approval gates** — sending an unapproved artifact draft is refused; editing
  an approved draft revokes the approval; a recipient outside the allow-list is
  refused at draft time.
- **Delivery** — an approved alert draft sends with no PDF attachment; a second
  send is idempotent and does not re-transmit.
- **Audit** — draft creation, approval and delivery each append an audit entry
  naming the subject type and subject id.
- **Regression** — the report path still refuses to send until the report is
  approved, and its legacy hash preimage is unchanged.

## Deferred acceptance

Delivery is verified against a monkeypatched SMTP transport, as elsewhere in the
suite; no message leaves the test process. Acceptance against a real mail server,
and against alerts raised by physical ESP32 hardware, belongs to Step 12 and is
not claimed here.
