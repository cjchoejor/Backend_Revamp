# SIG-S2 v1.3 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S2-v1_3.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1** (Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration).

**Generated:** 2026-05-12 (implementation pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| S2 pricing engine slice (`resolve` / `resolveS2Pricing`, MSR, deterrent tier, group band, discount vs authority) | **DONE** | `back_end/src/engines/pricing-pipeline-engine.ts` |
| Policy 19 S2 resolver delegates to engine | **DONE** | `back_end/src/policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.ts` |
| Policy 7 send-time governance config (validity + ack windows) | **DONE** | `back_end/src/policies/08-pricing-rate-plan/p07-quotation-validity-and-ack-config-s2.ts` |
| Quotation document stub (`DocumentGenerationInterface` slice) | **DONE** | `back_end/src/services/infrastructure/document-generation-service.ts` |
| `QuotationService`: create/group with `S2ResolvePricingResult`, GM **below-MSR waiver** (`belowMsrGmWaiver`), traces `QUOTATION.MSR_GM_WAIVED` | **DONE** | `s2-quotation-service.ts`, `p19-msr-gm-waiver-below-msr-s2.ts`, `dtos/05-quotations-and-holds/request-schemas.ts` |
| `applyDiscount`: MSR waiver + trace | **DONE** | `s2-quotation-service.ts` |
| `sendQuotation`: enforce send governance, generate document ref, merge into comm payload, `QUOTATION.SENT` trace | **DONE** | `s2-quotation-service.ts` |
| S1→S2 & S3→S2: schedule `STAGE_DWELL_MONITOR` via shared helper | **DONE** | `back_end/src/lib/schedule-s2-dwell-warning-monitor.ts`, `s1-state-machine.ts`, `s3-reentry-state-machine.ts` |
| S3→S2 API: `renegotiationContext` (hold expiry, folio hints) | **DONE** | `s3-reentry-state-machine.ts`, `routes/reservations/router.ts` |
| Seed: S2 thresholds under `stageDwell.thresholds`, `pricing.ratePlans[].msr`, `quotation.document.templateKey` | **DONE** | `back_end/prisma/seed.ts` |
| `EntryService` façade exports: `progressS2ToS3`, `parkEntry`, `unparkEntry` | **DONE** | `back_end/src/services/domain/entry-service.ts` |
| S4 confirmation nightly rate reads `effectiveRate` / `resolvedNightlyRate` | **DONE** | `back_end/src/services/domain/s4-confirmation-service.ts` |

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

Same convention as **SIG-S1 matrix**: finalized specs live under **`DEV-SPEC finalization/`** (space in folder name). SIG **`-REV1` / `-REV2`** suffixes may not appear on filenames; use the Part folder + MOMs when reconciling.

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (7, 19, 23, 25, 37, 52, 65, 71) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 11 Integration | `DEV-SPEC finalization/DEV-SPEC Part 11/` (if present) |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S2-heavy)

| Atlas category | S2 artefacts in repo |
|----------------|---------------------|
| **Cat 03** | `state-machines/s1-state-machine.ts` (into S2 + dwell timer), `state-machines/s2-s3-state-machine.ts`, `state-machines/s2-quotation-state-machine.ts` |
| **Cat 05** | `engines/pricing-pipeline-engine.ts` |
| **Cat 06** | `policies/08-pricing-rate-plan/p07-*`, `p19-rate-plan-resolution-for-s2-quotation.ts`, `p65-*`, `policies/09-discount/p23-*`, `policies/10-speculative-hold/p25-*`, `policies/15-foc/p37-*`, `policies/20-communication-acknowledgement-tracking/p52-*`, `policies/01-availability/p01-s2-*` |
| **Cat 07 Domain** | `services/domain/s2-quotation-service.ts`, `s2-hold-service.ts`, `quotation-service.ts` (barrel), `entry-service.ts`, `s3-reservation-setup-service.ts` |
| **Cat 07 Infrastructure** | `document-generation-service.ts`, `timer-management-service.ts` |
| **Cat 08** | `workers/w1-stage-dwell-monitor.ts`, workers wired for `QUOTATION_VALIDITY_W15`, `QUOTATION_ACK_TRACKER`, `ACKNOWLEDGEMENT_WINDOW_W22` (see `workers/runner.ts`) |
| **Cat 10** | `routes/quotations-and-holds/router.ts`, `routes/entries/router.ts`, `routes/reservations/router.ts` (S2→S3 progression) |
| **Cat 12** | `prisma/seed.ts` / `ConfigurationEntry` keys: `expiry.s2.*`, `acknowledgement.windowPerType`, `pricing.ratePlans`, `discount.fom.maxPercentage`, `discount.gm.maxPercentage`, `speculativeHold.placementThresholds`, `quotation.document.templateKey`, `stageDwell.thresholds` (S2 row) |

---

## 3. Policy inventory (SIG-S2 §4 / confirmation table)

| Policy | Role at S2 | Primary implementation |
|--------|------------|-------------------------|
| **7** | Quotation lifecycle / validity | `p07-quotation-lifecycle-state-guards.ts`, `p07-quotation-validity-and-ack-config-s2.ts`, `p07-quotation-validity-not-lapsed-for-s2-exit.ts`, `s2-quotation-service.ts` (send, expire worker entrypoint) |
| **19** | Rate resolution; below-MSR requires **L3** + documented waiver | `p19-rate-plan-resolution-for-s2-quotation.ts`, `p19-msr-gm-waiver-below-msr-s2.ts`, `pricing-pipeline-engine.ts` |
| **23** | Discount governance | `p23-*` + `applyDiscount` / `sendQuotation` / S2→S3 gates |
| **25** | Speculative hold | `p25-speculative-hold-*`, `s2-hold-service.ts` |
| **37** | FOC / group | `p37-foc-entitlement-for-s2-group-quotation.ts` |
| **52** | Ack / open loop | `p52-*`, `communication-service.ts`, quotation send timers |
| **65** | Group rate context | `p65-group-rate-context-for-s2-quotation.ts` |
| **71** | Processing lock (when applicable at boundary) | `p71-*`, `s1-processing-lock-service.ts` |

Legend: **OK** = wired end-to-end for the happy path · **PARTIAL** = stub or incomplete vs full DEV-SPEC narrative · **MISSING** = not found

---

## 4. Services & engines (SIG §5–§6)

| SIG name | Status | Repo |
|----------|--------|------|
| **PricingPipelineEngine.resolve** | **PARTIAL/OK** | `resolve` / `resolveS2Pricing` in `pricing-pipeline-engine.ts`; S1 chip still uses `resolveIndicativePricing` |
| **QuotationService** | **PARTIAL** | `s2-quotation-service.ts` + `quotation-service.ts` — re-entry from S3→S2 segment flow, verbal promise enforcement, and full override paths may still be narrower than Part 6 |
| **HoldService** | **PARTIAL** | `s2-hold-service.ts` / `hold-service.ts` |
| **TimerEngine / register** | **PARTIAL** | `getTimerEngine` + pg-boss job names align with SIG timer codes; naming may differ from literal `TimerEngine.register` in spec |
| **DocumentGenerationInterface** | **PARTIAL** | `generateQuotationDocument` returns stub storage reference; PDF pipeline TBD |

---

## 5. Workers & timers (SIG §7–§8)

| Worker / timer | Status | Notes |
|------------------|--------|-------|
| **W1** Stage dwell | **OK** | Fires from `STAGE_DWELL_MONITOR`; **S1→S2** and **S3→S2** schedule first check via `lib/schedule-s2-dwell-warning-monitor.ts` |
| **W15** Quotation expiry | **PARTIAL** | `expireQuotation` in `s2-quotation-service.ts` + `QUOTATION_VALIDITY_W15` schedule on send |
| **W22** Ack window | **PARTIAL** | `ACKNOWLEDGEMENT_WINDOW_W22` on outbound quotation communication |

---

## 6. Routes (SIG §9)

| Area | Router | Notes |
|------|--------|-------|
| Quotations & holds | `routes/quotations-and-holds/router.ts` | Uses `quotation-service` façade → `s2-quotation-service` |
| Entry park / stage | `routes/entries/router.ts` | Park/unpark; `EntryService` façade in `entry-service.ts` also exports these |
| S2→S3 / S3→S2 | `routes/reservations/router.ts` | `progressS2ToS3`; **`POST …/re-entry/s2`** returns `{ entry, renegotiationContext }` |

---

## 7. Configuration keys (minimal set for S2 smoke)

See **`back_end/prisma/seed.ts`** block labelled SIG-S2: `expiry.s2.quotationValidityDays`, `expiry.s2.speculativeHoldTtlSeconds`, `acknowledgement.windowPerType`, `pricing.ratePlans`, `discount.fom.maxPercentage`, `discount.gm.maxPercentage`, `speculativeHold.placementThresholds`, `quotation.document.templateKey`, and **`stageDwell.thresholds.S2`**.

---

## 8. Follow-ups (narrower scope)

- **S3→S2 narrative depth** — `ReEntryConsequenceEngine` remains a trace-first marker; enrich with explicit hold/folio side-effects only where Part 6 requires more than read-only context.
- **Document pipeline** — Replace quotation document stub with rendered artefact + durable storage.
- **S2 automated acceptance** — Add `test:s2` / `S2-test-report.md` when the slice harness is ready.
