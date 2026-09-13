# Steps 9–10 Practical Usability Checklist

This checklist is the manual usability gate for Traceveil's persisted
visualizations and grounded investigation assistant. It assumes the earlier
batch workflow is already covered by `batch-practical-usability-checklist.md`.

## Test scope and pass rule

Test with at least one populated batch case, one historical analysis snapshot,
and, where available, one case containing preserved live events. Run the checks
once with Ollama available and once with Ollama stopped.

The gate passes when every **Required** item is checked, no Critical or High
usability defect remains open, and a new reviewer can complete the end-to-end
scenario without developer guidance. Items marked **Optional AI** may be skipped
when Ollama or the configured model is unavailable, but the offline experience
must still pass.

Record defects with the page, case and analysis IDs, browser, exact action,
expected result, actual result, severity, and a screenshot when useful.

## Test evidence — 2026-09-10

| Check | Result | Evidence |
| --- | --- | --- |
| Core runtime | Pass | Frontend, API, database, and Ollama health endpoints responded successfully. |
| Local model | Pass | `qwen35-uncensored:latest`; Qwen 3.5 family, 9.7B, Q4_K_M, 32K active context. |
| Grounded explanation | Pass | Selected case 7 timeline reference completed in 11.2 seconds using Qwen, with one accepted persisted citation and no fallback. |
| Requested visualization | Pass | A requested timeline completed in 17.3 seconds using Qwen; the UI rendered one validated timeline component from backend-resolved data. |
| Citation navigation | Partial | The citation opens case 7 Timeline with the correct reference in the URL, but the referenced finding is not automatically focused, expanded, or highlighted. |
| Automated backend | Pass | 148 tests passed; one third-party Starlette deprecation warning remains. |
| Automated frontend | Pass | 82 tests passed across 15 test files. |

Observed follow-up issues:

- [ ] **Medium:** Make citation navigation focus or expand the exact referenced
  timeline record instead of only opening the containing Timeline page.
- [ ] **Medium:** Keep selected-reference visualizations visually bounded. The
  validated timeline layout resolves the full snapshot and is extremely dense,
  even when the conversation is pinned to one finding.
- [ ] **Needs reproduction:** One rapid back-to-back assistant submission
  returned a transient `database_unavailable` response while database health
  remained OK; a retry succeeded.

## 1. Startup and capability clarity — Required

- [x] Frontend loads successfully at `http://127.0.0.1:5173`.
- [x] Backend health reports OK at `http://127.0.0.1:8000/api/v1/health`.
- [x] Database health reports OK at `http://127.0.0.1:8000/api/v1/health/db`.
- [x] AI health accurately reports `qwen35-uncensored:latest` as installed and
  available in the current local session.
- [ ] System Status distinguishes core-service failure from optional AI being
  offline; an offline model must not make the whole product look broken.
- [ ] Refreshing the browser on Overview, a case tab, Visualizations, and the
  Assistant restores the same usable route instead of showing a blank page.
- [ ] Navigation labels and selected states make the current location obvious.

## 2. Entering a real investigation — Required

- [ ] A reviewer can identify a populated case from the Cases page without
  knowing its internal ID.
- [ ] Opening the case shows persisted counts and status that agree with the
  evidence, events, findings, and analysis pages.
- [ ] Loading, empty, partial-result, and backend-error states explain what is
  happening and offer a useful next action.
- [ ] Refresh and Retry update the current view without losing the active tab,
  filters, page, or selected historical analysis.
- [ ] Evidence and analytical references are visibly interactive where they
  lead to another record; plain labels do not look like broken links.

## 3. Step 9 visualizations — Required

- [ ] A visualization overview is available for a populated case without
  requiring Ollama.
- [ ] The default visualization answers an obvious investigation question and
  does not require the reviewer to understand a chart configuration schema.
- [ ] Each supported visualization type renders: event activity, severity
  distribution, event categories, device activity, timeline, and graph.
- [ ] Titles, labels, legends, axes, units, time zones, and risk/severity colors
  are readable and unambiguous.
- [ ] Values in every visualization agree with the persisted case records and
  the selected `analysis_id`; no mock or cross-case value appears.
- [ ] Selecting a historical analysis pins all affected visualizations to that
  snapshot and clearly labels the historical state.
- [ ] Returning to Latest restores current results without a full page reload.
- [ ] Empty datasets produce an informative empty state, not misleading zeroed
  charts, NaN values, clipped labels, or a crash.
- [ ] Dense datasets remain inspectable: important labels are not silently
  hidden and graph/timeline interactions remain controllable.
- [ ] Invalid or unsupported visualization instructions fail safely with a
  bounded error/fallback; they never execute arbitrary markup or script.
- [ ] A visualization can be understood at laptop width and at 200% browser
  zoom without essential controls becoming unreachable.

## 4. Assistant entry and conversation management — Required

- [ ] Opening Assistant directly provides a clear case-selection or empty state.
- [ ] Opening **Explain in Assistant** or **Investigate with Assistant** carries
  the correct case plus the selected finding, evidence, alert, or event.
- [ ] Pinned context is visible before sending and can be reviewed or removed.
  Visibility and navigation passed; removal still needs manual verification.
- [ ] Starting a new chat does not overwrite an older conversation.
- [ ] Conversation history identifies the case and is understandable without
  relying on an opaque chat ID.
- [ ] Reopening a conversation, navigating away and back, and refreshing the
  page preserve its messages and selected case.
- [ ] Switching cases cannot retain hidden context or citations from the
  previous case.

## 5. Step 10 grounded answers — Optional AI

- [ ] Ask for the case summary; the answer is concise, clearly AI-generated,
  and separates persisted facts from interpretation.
- [ ] Ask why a finding exists; the answer explains its deterministic condition
  trace and risk factors without claiming the model created the finding.
- [ ] Ask about a selected evidence record; the answer uses the correct source,
  canonical event, timestamp, entities, and provenance.
- [ ] Ask about correlations or an incident sequence; the chronology and
  relationships agree with the selected analysis snapshot.
- [ ] Ask about preserved live activity; the answer distinguishes live origin,
  durable evidence, and later analysis.
- [ ] Every specific factual claim that needs support has a visible verified
  citation or reference to a persisted record.
- [ ] Citation controls open the correct case-scoped record and preserve the
  active `analysis_id` when applicable.
- [ ] The answer does not invent counts, identifiers, timestamps, devices,
  severities, risk scores, or evidence that retrieval did not provide.
- [ ] Ambiguous or unsupported questions produce a bounded uncertainty message
  and a useful suggestion instead of fabricated certainty.
- [ ] Repeating the same prompt cannot silently change deterministic facts.

## 6. AI-offline and failure recovery — Required

- [ ] With Ollama stopped, the Assistant explicitly says the optional local AI
  service/model is unavailable and leaves core investigation pages usable.
- [ ] No placeholder or mock answer is presented as a real model response.
- [ ] A failed send preserves the user's prompt and pinned context for Retry.
- [ ] Retry works after Ollama recovers without duplicating the user message or
  creating two assistant responses.
- [ ] A slow request shows progress, supports cancellation, and returns the UI
  to a usable state after cancel or timeout.
- [ ] Rapid sends, route changes, and retries cannot let an older response
  overwrite the active conversation.
- [ ] Backend/database loss is distinguished from AI-only loss and provides an
  appropriate recovery action.

## 7. Cross-feature investigation flow — Required

- [ ] From a finding, open the Assistant, inspect its citations, return to the
  cited evidence, and get back to the same conversation without losing context.
- [ ] From a visualization anomaly, locate the corresponding persisted records
  and ask a case-scoped question about them.
- [ ] From a live alert or event, enter the Assistant with the expected pinned
  reference and verify that any later citation points to preserved data.
- [ ] Historical analysis context remains consistent across Findings,
  Visualizations, references, and Assistant entry points.
- [ ] Reanalysis creates or reuses a snapshot as stated, refreshes the relevant
  visuals, and does not retroactively alter an older conversation's citations.

## 8. Interaction, accessibility, and responsive use — Required

- [ ] All primary flows can be completed with a keyboard; focus order follows
  the visual order and the focus indicator is always visible.
- [ ] `Enter` sends a chat message and `Shift+Enter` adds a line break, with this
  behavior discoverable from the composer.
- [ ] Buttons, icon controls, inputs, filters, chart controls, and citation links
  have meaningful accessible names and usable target sizes.
- [ ] Loading, success, offline, and error changes are announced without
  repeatedly interrupting assistive-technology users.
- [ ] Text, severity states, focus rings, and chart series do not rely on color
  alone and remain distinguishable in both light and dark interface areas.
- [ ] At 1280×720 and 200% zoom, the composer, pinned context, citations, chart
  legends, and navigation remain visible and operable without horizontal page
  scrolling.
- [ ] Long prompts, long record IDs, many citations, and long model answers wrap
  or scroll locally without breaking the page layout.

## 9. New-reviewer acceptance scenario — Required

A reviewer unfamiliar with the codebase must be able to complete this sequence
without developer assistance:

- [ ] Start from System Status and correctly explain which capabilities are
  available.
- [ ] Open a populated case and identify its latest analysis.
- [ ] Use at least three visualizations to identify a high-risk subject, when it
  happened, and the supporting event category or relationship.
- [ ] Open a relevant finding or evidence record in the Assistant with its
  context pinned.
- [ ] Ask one factual and one interpretive question, then verify at least two
  citations against persisted records.
- [ ] Open an older analysis and recognize that it is historical.
- [ ] Refresh or navigate away and return without losing the investigation.
- [ ] Explain that deterministic results remain authoritative and AI text is an
  optional grounded aid.
- [ ] With Ollama unavailable, recognize the limitation and continue reviewing
  the case successfully.

## Sign-off

| Field | Result |
| --- | --- |
| Tester / date |  |
| Browser / viewport |  |
| Case ID(s) |  |
| Analysis ID(s) |  |
| Ollama model and availability |  |
| Required items passed |  |
| Optional AI items passed / skipped |  |
| Open Critical / High defects |  |
| Final decision | Pass / Fail |
