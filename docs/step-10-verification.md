# Step 10 — AI Investigation Chat Verification

Step 10 is complete for local, persisted Traceveil investigations. Step 9 remains
the authority for visualization layouts and deterministic display datasets.

## Delivered behavior

- Case-scoped, automatic cross-case, and selected-reference sessions are
  validated before persistence.
- Selected references support findings, alerts, incidents, timeline records,
  evidence files, canonical events, and correlation edges. Missing and
  cross-case references are rejected.
- Deterministic lexical retrieval ranks a bounded set of current persisted facts
  while explicit selections remain locked to the requested records.
- Explanation packets cover alert rules, risk scores and factors, correlation
  relationships, timestamp-ordered incident sequences, evidence provenance, and
  canonical events.
- Qwen is instructed to narrate supplied facts only. Citations are mandatory when
  context exists and must come from the retrieval allow list. Unsafe answers and
  numerical claims absent from the supplied facts are rejected.
- Ollama network failures and invalid model output produce persisted,
  evidence-linked deterministic answers rather than failed conversations.
- Session and message history is durable in SQLite. Sessions expose derived
  titles, message counts, and update times and can be reopened after refresh.
- The connected React page accepts case and record references from the URL,
  displays locked context, offers history and new-chat controls, supports cancel,
  and stops job polling after a bounded deadline.

## Verification

Backend tests cover offline completion, durable history, reference validation,
selected-event answers, mandatory citations, invented-number rejection, safe
visual layouts, and deterministic alert, risk, correlation, and sequence packets.

Run from `backend`:

```powershell
& '..\.runtime\Scripts\python.exe' -m pytest -q
& '..\.runtime\Scripts\python.exe' export_openapi.py ..\frontend\src\api\openapi.json --check
```

Run from `frontend`:

```powershell
npm run api:types
npm test -- --run
npm run build
```

The completion run passed the complete backend suite, all 82 frontend tests, the
production TypeScript/Vite build, and OpenAPI regeneration.
