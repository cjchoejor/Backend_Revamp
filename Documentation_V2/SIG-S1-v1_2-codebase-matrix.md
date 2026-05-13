# SIG-S1 v1.2 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S1-v1_2.md` against `back_end/src`, map SIG **source document** names to **`DEV-SPEC finalization/`** (similar filenames), and record **where new work should land** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 13 DTOs, Cat 16 audit, etc.).

**Generated:** 2026-05-11 (agent pass)  
**Last updated:** 2026-05-12 (implementation pass)

---

## 0. Implementation delta (what we implemented)

| Change | Status | Files |
|--------|--------|-------|
| Atlas Cat 03 S1 state machine module for S1 transitions | **DONE** | `back_end/src/state-machines/s1-state-machine.ts` (re-exported from `back_end/src/services/domain/s1-entry-service.ts`) |
| Domain façade for duplicate detection | **DONE** | `back_end/src/services/domain/duplicate-detection-service.ts` + rewired `back_end/src/services/domain/s1-inquiry-service.ts` |
| Infrastructure `AuditService` wrapper around `TraceEvent` | **DONE** | `back_end/src/services/infrastructure/audit-service.ts` |
| Infrastructure `NotificationService` (audit-backed) + hooks | **DONE** | `back_end/src/services/infrastructure/notification-service.ts` + W1/W16/W20 hooks |
| Notification routing keys + config-driven targets | **DONE** | `back_end/prisma/seed.ts` (`notification.routing.*`) + `back_end/src/services/infrastructure/notification-service.ts` |
| Workers W1/W16/W20 now emit trace via `auditService.emit` | **DONE** | `back_end/src/workers/w1-stage-dwell-monitor.ts`, `back_end/src/workers/w16-processing-lock-expiry-worker.ts`, `back_end/src/workers/w20-entry-expiry-worker.ts` |
| Route alignment for entry fetch | **DONE** | `back_end/src/routes/entries/router.ts` now has `GET /entries/:id` (removed from `routes/reservations/router.ts`) |
| W7 schema scaffolding for ingestion + drafts | **DONE** | `back_end/prisma/schema.prisma` (AiDraft/HumanDecision + comm entryId nullable) + `back_end/src/workers/w7-ota-email-parser-worker.ts` |

---

## 1. SIG “Source Documents” row → DEV-SPEC finalization folder

SIG-S1 v1.2 § “Source Documents” (lines 22–37) lists **REV1** filenames where applicable. Under repo root, the finalized specs live under **`DEV-SPEC finalization/`** (note the **space** in the folder name). **There is no separate `dev-spec-finalization` path** in this workspace.

| SIG cites | Closest match under `DEV-SPEC finalization/` | Notes |
|-----------|-----------------------------------------------|--------|
| `DEV-SPEC-001-Part2-REV1.md` (Schema) | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` | **`-REV1` suffix not in folder filename** — treat as same lineage; verify against CORRECTIONS / MOMs if deltas matter. |
| `DEV-SPEC-001-Part3.md` (State machine) | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` | Present. |
| `DEV-SPEC-001-Part4.md` (Engines) | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` | Present. |
| `DEV-SPEC-001-Part5-REV1.md` (Policies) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` | **`-REV1` not in filename** — use Part 5 folder + `MOM-ARCH-2026-014.md` for amendments. |
| `DEV-SPEC-001-Part6-REV1.md` (Services) | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` | **`-REV1` not in filename** — use Part 6 + `MOM-ARCH-2026-015.md`. |
| `DEV-SPEC-001-Part8.md` (Workers) | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` | Present. |
| `DEV-SPEC-001-Part9-REV1.md` (Routes) | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` | **`-REV1` not in filename**. |
| `DEV-SPEC-001-Part12.md` (Configuration) | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` | Present. |
| `DEV-SPEC-001-Part13.md` (Acceptance gates) | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` | Present. |

**Missing from `DEV-SPEC finalization/` as separate Part files:** SIG also references **`Canon_Block5_S1_S2_REV2_2.md`** (charter) — not found as that exact name under `DEV-SPEC finalization/` in this scan; may live only under `docs/` or elsewhere.

---

## 2. BACKEND-STRUCTURAL-ATLAS — where things go in `back_end/src`

From **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (navigation / Cat captions): canonical backend layout aligns with:

| Atlas category | Typical `back_end/src` placement |
|----------------|----------------------------------|
| **Cat 03** State machines | `state-machines/` (and/or guards co-located with domain services today) |
| **Cat 05** Engines | `engines/*.ts` — pure logic, no Prisma in engine modules |
| **Cat 06** Policies | `policies/{nn-topic}/p*.ts` — one concern per module; **no** business orchestration |
| **Cat 07** Services — Domain | `services/domain/*-service.ts` — orchestration, transactions, Prisma |
| **Cat 07** Services — Application | `services/application/*-service.ts` |
| **Cat 07** Services — Infrastructure | `services/infrastructure/*-service.ts` (session, timers, etc.) |
| **Cat 08** Workers | `workers/w*-*.ts` + registration in `workers/runner.ts` |
| **Cat 10** Routes | `routes/{feature}/router.ts`, mounted from `routes/api-router.ts` |
| **Cat 13** DTOs | `dtos/{nn-topic}/request-schemas.ts` (+ response types as you add them) |
| **Cat 16** Audit | SIG requires **`AuditService`**; Atlas describes trace discipline — today code often uses `traceEvent.create` inside services |

---

## 3. Section-by-section completeness (SIG-S1 v1.2)

Legend: **OK** = largely aligned · **PARTIAL** = exists with gaps · **MISSING** = not present · **N/A** = spec deferred to Part 3 file / external only

### §1 Stage identity & §1.3 re-entry

| Item | Status | Repo / notes |
|------|--------|--------------|
| S1 purpose / exit narrative | OK | Documented behaviour spread across `s1-*-service`, policies, `s3-reentry-service` for S3→S1 |
| `ReEntryConsequenceEngine` on S3→S1 | PARTIAL | `engines/re-entry-consequence-engine.ts` + `services/domain/s3-reentry-service.ts`; verify full SIG transaction list vs implementation |

### §2 Schema models active at S1

| Item | Status | Repo / notes |
|------|--------|--------------|
| Prisma models (Inquiry, Entry, Segment, AvailabilityConfiguration, …) | OK | `back_end/prisma/schema.prisma` — compare field-by-field to **Part 2** when hardening |

### §3 State machine at S1

| Item | Status | Repo / notes |
|------|--------|--------------|
| Explicit state-machine modules | **OK** | Implemented in `back_end/src/state-machines/s1-state-machine.ts` (S1 transitions) and re-exported from `back_end/src/services/domain/s1-entry-service.ts` for compatibility |
| Part 3 DEV-SPEC detail | N/A | Read: `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |

### §4 Policies (primary `### Policy` list — **8**)

| Policy | Status | Primary `src` mapping |
|--------|--------|------------------------|
| **P1** Availability query | PARTIAL | `policies/01-availability/p01-availability-query-params-s1.ts` + `engines/availability-engine.ts` + `s1-availability-service.ts` |
| **P2** DEFICIENT surface | PARTIAL | Engine buckets + `selectOption` ack; dedicated “annotation-only” policy file optional |
| **P3** Initial custodian | PARTIAL | `policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.ts` — SIG **ESCALATE(FOM) / unset custodian** path not modelled |
| **P4** Custodian reassignment | PARTIAL | `p04-custodian-reassignment.ts` + inquiry/entry routes |
| **P6** Inquiry / entry expiry | PARTIAL | **W20** updates entry + trace; SIG **`EntryService.expireEntry()`** facade not present as a domain method |
| **P12** Duplicate gate | PARTIAL | `p12-inquiry-duplicate-at-creation.ts` (conditional on proposed dates) + flags + S1 exit gate; not a standalone **`DuplicateDetectionService`** class |
| **P19** Indicative at S1 | PARTIAL | `p19-rate-plan-resolution-for-s1-indicative.ts` + `pricing-pipeline-engine.ts`; SIG also names **`PricingPipelineEngine.resolve()`** wording — engine exposes **`resolveIndicativePricing`** |
| **P69** Session / PIN | PARTIAL | `session-service.ts` + `routes/session-and-authentication/router.ts` |

**Also invoked in SIG §6/§7 for S1 (outside §4 headers):** P14 (shadow — config + engine), P15 (guest identity — `p16-s1-exit-entry-and-contact-gates` etc.), P64 (`p64-*`), P67 (`p67-*`, turnaround), P71/P72 (`p71-*`, `p72-*`), P73–P75 (W7 / AI trust — **no** dedicated `p73`–`p75` modules in `src`).

### §5 Engines

| Engine | Status | Repo |
|--------|--------|------|
| **AvailabilityEngine** | OK | `engines/availability-engine.ts` |
| **PricingPipelineEngine** | PARTIAL | `engines/pricing-pipeline-engine.ts` — **reconfirm** path does not re-run pricing (see §6.4) |

### §6 Services

| SIG surface | Status | Repo |
|-------------|--------|------|
| **InquiryService** | PARTIAL | `s1-inquiry-service.ts` — list/get, create, park/unpark, custodian, corporate context, duplicate resolution |
| **EntryService** (S1) | PARTIAL | `s1-entry-service.ts` — create, park/unpark, progress, auto-fulfil; **now includes** `expireEntry` used by W20 |
| **AvailabilityService** | PARTIAL | `s1-availability-service.ts` — query, get, recall, select; space alloc same-tx when `spaceId` + conference/catering |
| **ProcessingLockService** | PARTIAL | `s1-processing-lock-service.ts` — place, reconfirm, status, **expireLock**; **`reconfirm`** does **not** run Availability + Deficient + **Pricing** revalidation (SIG §6.4) |
| **SpaceAllocationService** | PARTIAL | `space-allocation-service.ts` — manual allocate + query-path quoted allocation |
| **SessionService** | PARTIAL | `session-service.ts` |
| **TimerManagementService** | PARTIAL | `timer-management-service.ts` / `getTimerEngine` |
| **NotificationService** | **PARTIAL** | Implemented as `back_end/src/services/infrastructure/notification-service.ts` (audit-backed). Wired into W1/W16/W20 dispatch surfaces; does not yet integrate with external channels (email/SMS/Slack/etc.) |
| **AuditService** | **PARTIAL** | Implemented as `back_end/src/services/infrastructure/audit-service.ts` and used by W1/W16/W20 + NotificationService; many services still call `traceEvent.create` directly |
| **DuplicateDetectionService** | **OK** | Façade present at `back_end/src/services/domain/duplicate-detection-service.ts` (policies remain the core, façade centralizes orchestration) |

### §7 Workers (SIG lists **4**)

| Worker | Status | Repo |
|--------|--------|------|
| **W1** StageDwellMonitor | PARTIAL | `workers/w1-stage-dwell-monitor.ts` now dispatches stage-dwell notifications and emits audit events via `auditService.emit`; still needs full SIG parity (tier routing & recipients) |
| **W16** ProcessingLockExpiry | PARTIAL | `workers/w16-processing-lock-expiry-worker.ts` now delegates to `services/domain/s1-processing-lock-service.ts::expireLock` (domain owns expiry + audit + notification) |
| **W20** EntryExpiry | PARTIAL | `workers/w20-entry-expiry-worker.ts` now delegates to `services/domain/s1-entry-service.ts::expireEntry` (domain owns expiry + audit + notification) |
| **W7** OTAEmailParser | PARTIAL | `workers/w7-ota-email-parser-worker.ts` — now does idempotent ingestion + draft/escalate audit events (IMAP + real AI classifier still pending) |

### §8 API routes (SIG §8 lists **24** route specs)

| Area | Status | Notes |
|------|--------|--------|
| Auth (4) | OK | `/api/auth/*` |
| Inquiries (7) | PARTIAL | Implemented; SIG pagination/cursor vs current `{ items, count }` may differ |
| Entries (7) | PARTIAL | `GET /entries/:id` is now on `routes/entries/router.ts` (SIG alignment improved) |
| Availability (4) | PARTIAL | Search + config get/recall/select OK; app also exposes **`POST …/entries/:id/availability/query`** (not one of the 24 §8 headings) |
| Processing locks (3) | PARTIAL | Routes OK; **reconfirm** service behaviour vs SIG |

### §9 Configuration keys at S1

| Item | Status | Repo / notes |
|------|--------|--------------|
| Keys catalogue | PARTIAL | `prisma/seed.ts` + `lib/config-store.ts` — diff vs **Part 12** (`DEV-SPEC finalization/.../Part 12/...`) for rename / missing keys |

### §10 Acceptance criteria

| Item | Status | Notes |
|------|--------|--------|
| Full AC matrix | PARTIAL | `back_end/scripts/s1-acceptance-tests.ts` now runs **without requiring API server** (falls back to service calls) and writes `Documentation_V2/S1-test-report.md` + `S1-test-output.json`. Part 13 gates still not fully covered. |

---

## 4. Remaining work (tabular)

| Area | What’s still missing / mismatched vs SIG-S1 | Suggested target (Atlas) |
|------|---------------------------------------------|---------------------------|
| **Entry expiry service façade** | **DONE** (`expireEntry` implemented and W20 delegates) | `back_end/src/services/domain/s1-entry-service.ts` |
| **Processing lock expiry façade** | **DONE** (`expireLock` implemented and W16 delegates) | `back_end/src/services/domain/s1-processing-lock-service.ts` |
| **Processing lock reconfirm revalidation** | **PARTIAL DONE**: `reconfirm` now computes availability/deficient/pricing deltas based on latest `AvailabilityConfiguration` + current engine run; still needs deeper SIG parity (shadow inventory / spaces / stricter delta contract) | `back_end/src/services/domain/s1-processing-lock-service.ts` |
| **Audit adoption across services** | Many code paths still use `traceEvent.create` directly (inconsistent actor/payload shape) | Incremental refactor: domain/application services → `back_end/src/services/infrastructure/audit-service.ts` |
| **Notification external integrations** | NotificationService now reads config-driven routing targets (seeded), but is still audit-backed only; no email/SMS/Slack integrations | `back_end/src/services/infrastructure/notification-service.ts` |
| **W7 OTA email parser parity** | **PARTIAL**: added schema support (`CommunicationRecord.entryId` nullable + `AiDraftRecord` + `HumanDecisionRecord`) and worker now performs idempotent ingestion by `messageId` with draft/escalate audit events (still no IMAP integration, no real AI classifier, no P73–P75 policy modules yet) | `back_end/prisma/schema.prisma`, `back_end/src/workers/w7-ota-email-parser-worker.ts` |
| **Routes alignment** | `GET /entries/:id` lives under `routes/reservations/router.ts` (SIG lists under entries) | `back_end/src/routes/entries/router.ts` + mount in `back_end/src/routes/api-router.ts` |
| **Config key diffs** | Need diff against Part 12 keys (thresholds, TTLs, notification routing) | `back_end/prisma/seed.ts` + `back_end/src/lib/config-store.ts` |
| **Acceptance gates** | Part 13 gates not fully automated/verified | policies + tests/scripts |

---

## 5. Quick “where to implement” cheat sheet (new S1 work)

| If SIG / Part says… | Add / change under… |
|---------------------|----------------------|
| New **policy** gate | `back_end/src/policies/{nn-...}/p*.ts` (Cat 06) |
| New **pure calculation** | `back_end/src/engines/` (Cat 05) |
| New **orchestration / Prisma tx** | `back_end/src/services/domain/s1-*-service.ts` or split service (Cat 07) |
| New **timer / session** mechanics | `back_end/src/services/infrastructure/` (Cat 07) |
| New **pg-boss consumer** | `back_end/src/workers/w*.ts` + `workers/runner.ts` (Cat 08) |
| New **HTTP surface** | `back_end/src/routes/{group}/router.ts` + `api-router.ts` (Cat 10) |
| New **request body** | `back_end/src/dtos/.../request-schemas.ts` (Cat 13) |
| **Stage transition graph** | Prefer new files under `back_end/src/state-machines/` then wire from `s1-entry-service` (Cat 03) |

---

*End of matrix. For edits to application code, switch to Agent mode and specify which gap to close first (e.g. `reconfirm` revalidation, `AuditService`, or `expireEntry` facade).*
