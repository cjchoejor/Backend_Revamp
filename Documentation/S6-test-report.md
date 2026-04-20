# S6 Acceptance Tests Report (Automated)

Generated: **2026-04-20**  
API base: `http://localhost:4000/api`

This report validates the implemented **Stage 6 (S6) — Check‑In & Stay/Event Initiation** behaviors against key acceptance criteria listed in `SIG-S6-v1_0.md` (Section 10).

Raw machine output is saved as `Documentation/S6-test-output.json`.

---

## Test environment / setup

- **Backend**: `back_end` (Express + Prisma)
- **DB**: PostgreSQL
- **Seed reset**: `npm run db:seed`
- **Auth headers**: all protected routes require:
  - `X-Actor-Id`
  - `X-Actor-Level`

Actors used by the test runner:
- **L1**: `test-fd-1`

Important note: The seed creates an entry in **S5**, so the test runner first performs the **full S5 readiness steps** via HTTP (H1 accept → room assign → H1 fulfil → tasks complete → progress to S6) and only then runs S6 assertions.

---

## What we tested (by acceptance criteria)

### S6 exit gating

- **AC-S6-028 — S6 exit blocked if identity not verified**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S7"`
  - **Test**: clear `GuestProfile.identityVerifiedAt` and attempt S6→S7
  - **Expected**: `409 StageGateBlockedError` with `blockingCondition = IDENTITY_NOT_VERIFIED`
  - **Result**: **PASS**

### Identity verification

- **AC-S6-001 — FIRST_TIME creates GuestIdentityDocument + retention expiry**
  - **Route**: `POST /guest-profiles/:id/verify-identity`
  - **Input**: `verificationPath = FIRST_TIME` with `documentType`, `documentNumber`
  - **Expected**:
    - `GuestIdentityDocument` created
    - `retentionPeriod` and `retentionExpiresAt` populated
    - `retentionExpiresAt ≈ capturedAt + retentionPeriod days`
  - **Result**: **PASS**

### Room readiness

- **AC-S6-011 — Check-in completion blocked if room not ready**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S7"`
  - **Test**: temporarily set assigned room `physicalState = DIRTY`
  - **Expected**: `409 StageGateBlockedError` with `blockingCondition = ROOM_NOT_READY`
  - **Result**: **PASS**

### Happy path completion (S6 → S7)

Validated as one integrated assertion block because the implementation executes these changes atomically in one transaction.

- **AC-S6-027 — Complete normal exit path**
- **AC-S6-005 — Folio PROVISIONAL→LIVE audited fields present**
- **AC-S6-010 — Room CONFIRMED→OCCUPIED + RoomClaimStateEvent exists**
- **AC-S6-012 — H1 closes during check-in**

  - **Route**: `POST /entries/:id/progress-stage` with:
    - `targetStage = "S7"`
    - `transitionData.keyCount >= 1`
    - `transitionData.registrationConfirmed = true`
  - **Expected**:
    - Entry: `currentStage = S7`
    - Folio: `state = LIVE`, `convertedToLiveAt != null`, `convertedBy != null`
    - Room: `currentClaimState = OCCUPIED`
    - `RoomClaimStateEvent(fromState=CONFIRMED,toState=OCCUPIED)` exists
    - H1: `state = CLOSED`, `closedAt != null`
    - H2 + H3 handoffs created in `CREATED` (Front Desk → Housekeeping / F&B)
  - **Result**: **PASS**

### Missing configuration behavior

- **AC-S6-033 — Missing `identity.documentTypes` blocks verify-identity**
  - **Route**: `POST /guest-profiles/:id/verify-identity`
  - **Test**: delete config key `identity.documentTypes`, then attempt FIRST_TIME verification
  - **Expected**: `422 MissingConfigurationError`
  - **Result**: **PASS**

- **AC-S6-034 — Missing `vipNotification.routingPerTier` blocks VIP completion**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S7"`
  - **Test**: create a VIP-tier guest/entry at S6, delete config key `vipNotification.routingPerTier`, attempt completion
  - **Expected**: `422 MissingConfigurationError`
  - **Result**: **PASS**

---

## Fixes applied while testing

These were needed to align implementation behavior with SIG-S6 configuration gates:

- **Identity verification now requires config keys**
  - File: `back_end/src/services/guest-profile-service.ts`
  - Change: if either `identity.documentTypes` or `identity.retentionPeriodDays` is missing, throw `MissingConfigurationError`.

- **Folio conversion now requires config key**
  - File: `back_end/src/services/folio-service.ts`
  - Change: if `billingModel.availablePerSource` is missing, throw `MissingConfigurationError`.

- **VIP completion now requires routing config**
  - File: `back_end/src/services/check-in-service.ts`
  - Change: if guest is VIP-tier and `vipNotification.routingPerTier` is missing, throw `MissingConfigurationError`.

---

## Not covered by this automated S6 run (current repo slice limits)

The following SIG-S6 acceptance items are not executable in this repo slice yet:

- **TraceEvent requirements** (AC-S6-005/012/…): this slice does not persist `TraceEvent`, so we cannot assert those audit rows.
- **W25 acceptance timers / `slaDeadlineAt`** on H2/H3 (AC-S6-015/017/019/035): timer engine not implemented.
- **H2/H3 “complete content” requirements** (AC-S6-015/017) beyond minimal checklistContent fields.
- **Walk-in path** (AC-S6-014/025/026): not implemented in this slice.
- **Re-entry S6→S1** (AC-S6-036): not implemented in this slice.
- **Folio immutability / revert prevention** (AC-S6-007/008): no API exists to attempt those invalid writes.

---

## How to re-run locally

From `back_end` (backend server must be running on port 4000):

```bash
npm run db:seed
npx tsx scripts/s6-acceptance-tests.ts > ..\\Documentation\\S6-test-output.json
```

