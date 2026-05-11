# Stage 02 (S2) — Audit report

- **Doc**: `SIG-S2-v1_3.md` + `LEGPHEL_Implementation_Reference_v1_1.html` (Layer 03a · S2 quotation flow)
- **Scope**: stage identity, schema models, engines, services, workers/timers, API routes, configuration keys, acceptance criteria, scenario tests.
- **Generated**: 2026-05-07

---

## 0) Completion status (DONE / PARTIAL / NOT DONE)

- **DONE**: Quotation lifecycle (DRAFT → SENT → ACCEPTED; SUPERSEDED; EXPIRED via W15)
- **DONE**: Validity timer + ack tracker timer registration at send
- **DONE**: Discount approval enforcement (send + S2→S3 exit blocks without `TraceEvent S2.DISCOUNT.APPROVED`)
- **DONE**: Speculative hold placement + expiry timer registration (W2) + L2 release rule
- **PARTIAL**: S2→S3 exit gate (implemented core gates; advanced “ack open loop resolution” is trace-only in this slice)
- **PARTIAL**: Group/FOC flows (not exhaustively modeled in this backend slice)
- **NOT DONE**: Full “S2 auto-fulfilment S1→S3” evidence path (TraceEvent-only compressed path not implemented as dedicated route)

---

## 1) What’s implemented (high-signal map)

### 1.1 Services
- `back_end/src/services/s2-quotation-service.ts`
  - `createQuotation()`: resolves pricing via config (`pricing.ratePlans`), creates DRAFT versions
  - `sendQuotation()`: seals to SENT, schedules `QUOTATION_VALIDITY_W15` and `QUOTATION_ACK_TRACKER`, creates `CommunicationRecord`
  - `acceptQuotation()`: transitions to ACCEPTED and cancels related timers / closes comm ack loop
  - `supersedeQuotationWithNewDraft()`: transitions prior to SUPERSEDED and creates a new DRAFT version
  - `approveDiscount()`: emits immutable `TraceEvent` approval used by send/exit guards
- `back_end/src/services/s2-hold-service.ts`
  - `placeSpeculativeHold()` and `releaseSpeculativeHold()` with timer registration and inventory claim transitions

### 1.2 Workers / timers active at S2
- `W15` `QUOTATION_VALIDITY_W15` → `src/workers/w15-quotation-expiry-worker.ts`
- `W22` `ACKNOWLEDGEMENT_WINDOW_W22` → `src/workers/w22-acknowledgement-window-worker.ts`
- `Quotation ack tracker` `QUOTATION_ACK_TRACKER` → `src/workers/w22-quotation-ack-tracker-worker.ts`
- `W2` `SPECULATIVE_HOLD_EXPIRY_W2` → `src/workers/w2-speculative-hold-expiry-worker.ts`
- `W1` stage dwell monitor continues to apply (cross-stage)

### 1.3 Routes
All are in `back_end/src/routes/s5-routes.ts` under `/api`:
- `POST /entries/:id/quotations`
- `POST /quotations/:id/send`
- `POST /quotations/:id/accept`
- `POST /quotations/:id/supersede`
- `POST /quotations/:id/discount/approve` (L2+)
- `POST /entries/:id/holds/speculative`
- `POST /entries/:id/holds/speculative/:holdId/release` (L2+)
- `POST /entries/:id/progress-stage` with `targetStage="S3"` (S2→S3)

---

## 2) Key S2 gates implemented (doc → code)

- **Accepted quotation required**: enforced in `progressS2ToS3()` (`NO_ACCEPTED_QUOTATION`)
- **Validity not lapsed**: `QUOTATION_VALIDITY_LAPSED` if accepted quote is past `validUntil`
- **Discount approval absolute**:
  - send blocks if discount exists without approval trace (`DISCOUNT_UNAPPROVED`)
  - exit blocks if accepted quote has discount without approval trace (`DISCOUNT_UNAPPROVED`)
- **Duplicate unresolved carry-forward**: exit blocks on `DUPLICATE_UNRESOLVED` (reuses S1 duplicate flags)
- **Speculative hold state (if present)**: exit blocks if speculative hold is not active (`SPEC_HOLD_NOT_ACTIVE`)

---

## 3) Scenario tests executed

See `Documentation_V2/Stage_02/README.md` for pass totals.

- `scenario_01_happy_path.md`
- `scenario_02_discount_requires_approval.md`
- `scenario_03_w15_expiry.md`
- `scenario_04_supersede_cancels_timers.md`
- `scenario_05_w22_ack_window_timeout.md`
- `scenario_06_w2_spec_hold_expiry.md`
- `scenario_07_ack_open_loop_blocks_exit.md`
- `scenario_08_hold_requires_fom_escalation.md`
- `scenario_09_hold_release_l2.md`
- `scenario_10_validity_lapsed_blocks_exit.md`
- `scenario_11_duplicate_open_blocks_exit.md`
- `scenario_12_auto_fulfil_s2.md`

---

## 4) Architectural notes / remaining work

- **CommunicationRecord.commType enum**: added `QUOTATION` so S2 can use a correct comm type instead of abusing unrelated values.
- **Test-only enqueue endpoint**: `POST /admin/enqueue` exists to schedule timers quickly in dev; this should be guarded/removed for production deployments.
- **Full SIG completeness**: remaining S2 scope includes group quotation/FOC entitlement paths and S1→S3 “S2 auto-fulfilled” evidence path if you want it as first-class behavior.

