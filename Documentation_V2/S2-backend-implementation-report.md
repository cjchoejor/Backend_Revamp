# S2 backend implementation report

**Date:** 2026-05-12  
**Scope:** Stage 2 (Negotiation & Quotation) alignment with `docs/SIG-S2-v1_3.md`, structural layout per `BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`, and entry lifecycle state-machine extraction completed earlier in the same programme of work.

---

## 1. Executive summary

The backend now exposes **SIG-named domain façades** (`quotation-service`, `hold-service`, `communication-service`) while keeping stage-scoped implementations in `s2-quotation-service` and `s2-hold-service`. **S2→S3** progression seals segment quotations, closes S2 stage dwell, and opens S3 dwell. **S1→S2** and **S3→S2** re-entry paths record stage dwell transitions. **Group quotations**, **`applyDiscount`**, centralised **`expireQuotation`** (used by W15), and a **fixed quotation send / acknowledgement timer** path were added. **`npm run build`** succeeds on the TypeScript tree.

Recent completion work closed **GM below-MSR waiver** (Policy-shaped gate + DTO + traces), **S3→S2** first dwell monitor schedule (shared helper with S1→S2), and **renegotiation context** on the S3→S2 API response. Remaining gaps versus a full SIG-S2 lock are narrowed in §5.

---

## 2. State machines (`back_end/src/state-machines/`)

| Module | Responsibility |
|--------|----------------|
| `s1-state-machine.ts` | S1→S2 progression; S1→S3 auto-fulfil; **S2 dwell warning monitor** via `lib/schedule-s2-dwell-warning-monitor.ts` |
| `s2-s3-state-machine.ts` | S2→S3 guards; transaction: **seal quotations**, **S2 dwell exit**, **S3 dwell enter**, entry stage |
| `s2-quotation-state-machine.ts` | `S2_QUOTATION_STATES`, `isQuotationSealedOnS2Exit` (quotation lifecycle labels) |
| `s3-reentry-state-machine.ts` | S3→S2 / S3→S1 backflows; S3→S2 **dwell monitor** + **`renegotiationContext`** (hold expiry, folio hints) on response |
| `entry-lifecycle-state-machine.ts` | S5→S6, S6→S7 (via check-in), S6→S1 re-entry, S7→S8 |
| `s8-s9-state-machine.ts` | S8→S9 (imports checkout helpers; no circular import with `s8-checkout-service`) |
| `index.ts` | Barrel re-exports for discovery |

**Note:** S3→S4 confirmation remains in `s4-confirmation-service` (large transaction); not extracted to a state-machine module by design.

---

## 3. SIG-S2 surface mapping

### 3.1 Services (SIG names ↔ code)

| SIG | Implementation |
|-----|----------------|
| `QuotationService` | `services/domain/quotation-service.ts` → `s2-quotation-service.ts` (`createQuotation`, `createGroupQuotation`, `applyDiscount`, `approveDiscount`, `sendQuotation`, `acceptQuotation`, `supersedeQuotationWithNewDraft`, `resolveAckOpenLoop`, `expireQuotation`) |
| `HoldService` (speculative) | `services/domain/hold-service.ts` → `s2-hold-service.ts` |
| `CommunicationService` (slice) | `services/domain/communication-service.ts` (`sendOutboundQuotationCommunication`) |
| `EntryService` park | `s1-entry-service.parkEntry` / `unparkEntry` with **S1 or S2** stage gate (`p01-entry-park-allowed-stages.ts`) |

### 3.2 Policies added or tightened for S2

| Policy | File |
|--------|------|
| 37 (FOC @ group quotation) | `policies/15-foc/p37-foc-entitlement-for-s2-group-quotation.ts` |
| 65 (group rate context) | `policies/08-pricing-rate-plan/p65-group-rate-context-for-s2-quotation.ts` |
| Park stages | `policies/01-availability/p01-entry-park-allowed-stages.ts` |
| 19 (rate resolution slice) | `p19-rate-plan-resolution-for-s2-quotation.ts` + engine |
| Below MSR (GM waiver, S2) | `policies/08-pricing-rate-plan/p19-msr-gm-waiver-below-msr-s2.ts` — **L3** + `belowMsrGmWaiver` on create / group / discount |

Existing S2-related policies (duplicate flags, quotation validity at exit, discount send/authority, speculative hold at exit, ack open-loop at exit) remain under their current paths.

### 3.3 Workers (SIG §7)

| Worker | Job / handler | Notes |
|--------|----------------|-------|
| W1 | `STAGE_DWELL_MONITOR` | Cross-stage |
| W2 | `SPECULATIVE_HOLD_EXPIRY_W2` | S2 |
| W15 | `QUOTATION_VALIDITY_W15` | Delegates to `expireQuotation()` in `s2-quotation-service` |
| W22 ack tracker | `QUOTATION_ACK_TRACKER` | `w22-quotation-ack-tracker-worker.ts` |
| W22 ack window | `ACKNOWLEDGEMENT_WINDOW_W22` | General comm ack |
| W16, W20 | Processing lock TTL, entry expiry | Cross-stage |

`w35-quotation-ack-worker.ts` exists as a thin wrapper; **one** pg-boss subscription is registered for `QUOTATION_ACK_TRACKER` to avoid duplicate handling.

### 3.4 Routes (`routes/quotations-and-holds/router.ts`)

| Method / path | Behaviour |
|----------------|-----------|
| `POST /entries/:id/quotations` | **GROUP** → `createGroupQuotation`; else `createQuotation` |
| `POST /quotations/:id/discount` | **New** — `applyDiscount` (L1+, body: discount percent + basis) |
| `POST /quotations/:id/discount/approve` | Existing GM/FOM approval trace |
| `POST /quotations/:id/send` | Send + validity + ack timers (bogus W22 pre-schedule removed) |
| `POST /quotations/:id/accept` | Accept + timer cancellation |
| `POST /entries/:id/holds/speculative` | Place hold |
| `POST /entries/:id/holds/speculative/:holdId/release` | Release (L2+) |
| Plus | Supersede, ack open-loop resolve, auto-fulfil S2→S3 |

DTO updates: `focRoomsRequested` on create quotation; `applyDiscountRequestSchema` (optional **`belowMsrGmWaiver`**); create quotation optional **`belowMsrGmWaiver`**.

### 3.5 Engines

| Engine | Path | S2 relevance |
|--------|------|--------------|
| Pricing pipeline (S2 slice) | `engines/pricing-pipeline-engine.ts` | `resolveS2Pricing` / `resolve`; MSR + deterrent + group band + discount caps; S1 chip via `resolveIndicativePricing` |
| FOC validation | `engines/foc-validation-engine.ts` | Group path + Policy 37 |
| Timer / pg-boss | `lib/timer-engine.ts`, `services/infrastructure/timer-management-service.ts` | Send / hold / dwell |

---

## 4. Configuration (SIG §9)

Seed and runtime expectations continue to use dotted keys such as:

- `expiry.s2.quotationValidityDays` (send default validity)
- `expiry.s2.speculativeHoldTtlSeconds`
- `discount.fom.maxPercentage`, `discount.gm.maxPercentage`
- `speculativeHold.placementThresholds`
- `acknowledgement.windowPerType`
- `foc.configuration` (FOC path; disabled placeholder still blocks invalid FOC when enabled)

See `back_end/prisma/seed.ts` for seeded rows.

---

## 5. Gaps and recommended follow-ups

1. **Document generation** — `generateQuotationDocument` still returns a deterministic storage stub; replace with real template render + object storage when the asset pipeline exists.
2. **S2 acceptance automation** — No `test:s2` script or `Documentation_V2/S2-test-report.md` yet (parallel to S1 slice tests).
3. **PricingPipelineEngine** — Further DEV-SPEC depth (multi-currency edge cases, richer override ledger) can extend the current S2-shaped resolver without changing route contracts.

---

## 6. Verification

- **TypeScript:** `npm run build` (from `back_end/`) — **pass** at time of report.

---

## 7. Related documents

- `docs/SIG-S2-v1_3.md` — normative S2 guideline  
- `Documentation_V2/S1-test-report.md` — S1 acceptance slice pattern (reference for future S2 tests)  
- `Documentation_V2/SIG-S1-v1_2-codebase-matrix.md` — S1 matrix pattern  
- `Documentation_V2/SIG-S2-v1_3-codebase-matrix.md` — S2 matrix (parity / traceability)

---

*End of report.*
