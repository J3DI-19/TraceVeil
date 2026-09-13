# Step 9 — Visualization Engine + Qwen Verification

Step 9 is complete for persisted Traceveil investigation data. It does not claim
completion of the conversational features tracked in Step 10.

## Delivered boundary

- Six production component types are allow-listed: timeline, risk breakdown,
  event activity, entity graph, evidence table, and alert list.
- `VisualizationLayoutV1` rejects extra fields, unsupported versions, unsafe
  titles, duplicate identifiers, invalid sizing, mismatched component/reference
  types, and layouts larger than six components.
- Data references identify a case, an explicit or latest analysis snapshot, and
  one allow-listed dataset type. Layouts never contain investigation datasets.
- The resolver reads persisted analysis artifacts and canonical events, applies
  fixed record limits, and returns typed display datasets.
- Qwen receives only the references it may select. Its output is validated before
  persistence, and invented numeric claims remain rejected by the existing
  grounded-response validator.
- Deterministic overview, timeline, risk, correlation, alert, evidence, and live
  fallbacks are available without Qwen.
- The connected React renderer consumes resolved API datasets. Mock datasets
  remain available only to the explicit mock workspace.
- Explicit analysis identifiers remain pinned for historical review. `latest`
  resolves the most recent persisted snapshot, including accepted live evidence
  after live reanalysis.

## Verification commands

From `backend`:

```powershell
& '..\.runtime\Scripts\python.exe' -m pytest -q
& '..\.runtime\Scripts\python.exe' export_openapi.py ..\frontend\src\api\openapi.json --check
```

From `frontend`:

```powershell
npm run api:types
npm test -- --run
npm run build
```

The Step 9 completion run passed the complete backend suite, all 82 frontend
tests, the production TypeScript/Vite build, and OpenAPI regeneration.
