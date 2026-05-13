# Test_ReVamp — stage-scenario reports (S1–S9)

This folder holds **per-stage** acceptance-style runs aligned with **Layer 03a / 03b / 03c** deep-dives in `LEGPHEL_Implementation_Reference_v1_1.html` (S1–S3, S4–S6, S7–S9).

## Layout

| Path | Purpose |
|------|---------|
| `lib/` | `report.ts`, `http-client.ts`, `split-acceptance-results.ts`, **`test-api-harness.ts`** (seed + temp API) |
| `stage-1/` … `stage-9/` | One folder per lifecycle stage; JSON reports land **in the same folder** as the runner |
| `stage-N/run-scenarios.ts` | Entry script for that stage |
| `stage-N/index.json` | Manifest of scenario JSON files produced by the last run |
| `stage-N/scenarios-from-reference.md` | **Intent**: scenario names / flows from the HTML reference (see per-stage file) |

## JSON report shape

Each `*.json` file follows:

```json
{
  "meta": {
    "stage": "S1",
    "scenarioName": "example-scenario-slug",
    "reference": "LEGPHEL_Implementation_Reference_v1_1.html#…",
    "generatedAt": "ISO-8601",
    "apiBaseUrl": "http://localhost:4000/api",
    "apiAvailable": true
  },
  "summary": { "passed": 0, "total": 0, "allPassed": false },
  "checks": [
    {
      "id": "AC-…",
      "title": "…",
      "pass": true,
      "httpStatus": 200,
      "response": {},
      "explanation": "…",
      "dbImpact": "…"
    }
  ]
}
```

**Stage 1** writes **multiple** scenario JSON files directly from `stage-1/run-scenarios.ts` (each scenario runs in-process in one invocation).

**Stages 2–4** start a **temporary test API** (see `lib/test-api-harness.ts`), run `scripts/sN-acceptance-tests.ts`, read **`Documentation_V2/SN-test-output.json`**, and emit **one JSON file per `steps[]` row**.

**Stages 5–9** use the same temporary API (`lib/test-api-harness.ts`): **S5** and **S6** parse **JSON stdout**; **S7–S9** read **`Documentation/S7|S8|S9-test-output.json`** after the delegated script run, emitting **one file per `results[]` row**.

**`npm run test:s8` / `test:s9`** remain as convenience wrappers (seed + inline temp server + acceptance) for CI or ad-hoc runs without the Test_ReVamp splitter.

## Commands (from `back_end/`)

```bash
npm run test:revamp:s1    # db:seed + Stage 1 harness
npm run test:revamp:s2    # db:seed + temp API + S2 + per-case JSON
# … test:revamp:s3 … s9: same temp API + delegated script + per-case JSON
```

- **S1**: optional API for full HTTP; seed included in `test:revamp:s1`.
- **S2–S7**: each `test:revamp:sN` runs **`db:seed`**, **`TEST_API_PORT`** (default **4010**), **`RUN_WORKERS=false`** — no manual `npm start`.
- **S8 / S9**: same temp API as S2–S7; scripts are DB-heavy and may run longer than S2–S4.

## Reference anchors in the HTML

- **03a**: `#layer-3a`, `#s1-deep`, `#s2-deep`, `#s3-deep`
- **03b**: `#layer-3b`, `#s4-deep`, `#s5-deep`, `#s6-deep`
- **03c**: `#layer-3c`, `#s7-deep`, `#s8-deep`, `#s9-deep`
