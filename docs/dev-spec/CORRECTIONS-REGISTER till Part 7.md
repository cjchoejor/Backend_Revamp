# LEGPHEL PMS — DEV-SPEC-001
# Corrections Register
# Cross-Part Audit — All Open Findings

**Document:** CORRECTIONS-REGISTER.md
**Date:** 08 April 2026
**Prepared by:** Claude (AI Architectural Partner)
**Source:** CROSS-PART-AUDIT.md (Session 1 + Session 2)
**Status:** Pending application — nothing applied yet

This register is optimised for editing execution. For each finding it states:
the file, the exact location, the exact current text, and the exact replacement.
No re-analysis required at editing time — each entry is self-contained.

Priority column: **BLOCK** = must fix before NoShowService SIG/code generation;
**DEFER** = safe to fix at end of all generation.

---

## CR-01 — F5-01 — Missing NoShowDeterminationRecord model

**Status:** APPLIED (2026-05-12) — but not as originally prescribed. See "Application notes" below.
**Priority:** BLOCK
**Files affected:** DEV-SPEC-001-Part2.md (3 sub-changes), DEV-SPEC-001-Part7.md (1 sub-change)

**Application notes (2026-05-12):**

When this register was written (2026-04-08), Part 2 had no `NoShowDeterminationRecord` model. By 2026-05-12, two competing definitions had been added — an operational-detail design and a financial-closure design — and `noShowDetermination` was already wired on `Entry`. CR-01-C's simple 5-field stub was a regression against both existing designs.

Applied path:
- **CR-01-A:** Applied verbatim. Mutation rule bullet added.
- **CR-01-B:** No-op — relation `noShowDetermination NoShowDeterminationRecord?` was already on `Entry`.
- **CR-01-C:** Deviated from prescription. The canonical model retained is the financial-closure design (anchors `entryId @unique`, `folioId`, `fomActorId`, `determinationType` ∈ {NO_SHOW, LATE_ARRIVAL_CONFIRMED}, `noShowPenaltyAmount`, `advancePaymentAmount`, `refundObligationAmount`, `otaNotificationRequired`, `determinedAt`, `createdAt`; relations to `entry` and `folio`). The duplicate operational-detail definition was deleted. The register's stub fields were NOT applied — the retained model is a strict superset and architecturally complete (anchors NO_SHOW_CLOSED folio closure as well as the penalty FolioLine).
- **CR-01-D:** Applied with field set aligned to the retained model. Added `findById`, `findByEntry` (idempotency guard, backed by `@unique` on `entryId`), and `findByFolio` (folio-closure lookup) — the register's two-query stub was extended to cover `FolioService` access patterns demanded by the canonical model's `folioId` anchor.
- **Model count:** Part 2 has 77 `@@map` tables. Part 7 header model count, §7.2 prose count, and §7.5 audit Step 2 target all bumped 76 → 77. Part 2 had no header count claim.

---

### CR-01-A — Part 2 §2.4.1 mutation rules prose block

**File:** DEV-SPEC-001-Part2.md
**Location:** §2.4.1, mutation rules prose block — after the line ending "Credit Ceiling Threshold Event: immutable from creation."

**Current text (last line of that bullet block):**
```
- Credit Ceiling Threshold Event: immutable from creation.
```

**Replace with:**
```
- Credit Ceiling Threshold Event: immutable from creation.
- No-Show Determination Record: immutable from creation; created by FOM at S5 on no-show determination; anchors the no-show penalty FolioLine; not amendable.
```

---

### CR-01-B — Part 2 §2.2.2 Entry model relation list

**File:** DEV-SPEC-001-Part2.md
**Location:** §2.2.2, `model Entry { }` — relation declarations block, after the line `commissionDueRecords CommissionDueRecord[]` and before `@@map("entries")`

**Current text:**
```prisma
  commissionDueRecords CommissionDueRecord[]

  @@map("entries")
```

**Replace with:**
```prisma
  commissionDueRecords CommissionDueRecord[]
  noShowDetermination  NoShowDeterminationRecord?

  @@map("entries")
```

---

### CR-01-C — Part 2 §2.4.2 new Prisma model

**File:** DEV-SPEC-001-Part2.md
**Location:** §2.4.2 Prisma code block — after the closing `}` of `CreditCeilingThresholdEvent` and before the closing triple backtick of the §2.4.2 code block

**Current text (end of §2.4.2 code block):**
```prisma
  ceilingRecord           CreditExtensionCeilingRecord @relation(fields: [ceilingRecordId], references: [id])

  // Mutation rule (§71): immutable from creation.
  @@map("credit_ceiling_threshold_events")
}
```

**Replace with:**
```prisma
  ceilingRecord           CreditExtensionCeilingRecord @relation(fields: [ceilingRecordId], references: [id])

  // Mutation rule (§71): immutable from creation.
  @@map("credit_ceiling_threshold_events")
}

model NoShowDeterminationRecord {
  // FOM determination event — created at S5 on no-show conclusion
  // Anchors the no-show penalty FolioLine as its operational source record
  id            String    @id @default(uuid())
  entryId       String    @unique
  // @unique — one determination per entry; idempotency enforced at schema level
  actorId       String    // FOM actor_id — NOT NULL; only FOM may determine no-show
  reason        String    // mandatory — free-text reason recorded at determination
  determinedAt  DateTime  // NOT NULL — FOM determination timestamp; not backdated
  createdAt     DateTime  @default(now())

  entry         Entry     @relation(fields: [entryId], references: [id])

  // Mutation rule (§71): immutable from creation. Not amendable.
  // Created by FOM at S5. Anchors the no-show penalty FolioLine.
  // Readable at S9 for post-closure audit.
  @@map("no_show_determination_records")
}
```

---

### CR-01-D — Part 7 §7.2.3 new model entry

**File:** DEV-SPEC-001-Part7.md
**Location:** §7.2.3 Financial — after the `CreditCeilingThresholdEventModel` entry (after its closing `---` separator) and before the `### 7.2.4 Rate and Pricing` heading

**Current text at that boundary:**
```
**Mutation rule:** Immutable from creation. Append-only threshold crossing record.

---

### 7.2.4 Rate and Pricing
```

**Replace with:**
```
**Mutation rule:** Immutable from creation. Append-only threshold crossing record.

---

#### NoShowDeterminationRecordModel

**Model name:** `NoShowDeterminationRecord`
**Table:** `no_show_determination_records`

**Query specifications:**

`findById(id: string): Promise<NoShowDeterminationRecord | null>`
```javascript
prisma.noShowDeterminationRecord.findUnique({ where: { id } })
```
Used by: `NoShowService` — direct lookup; `FolioService` — FolioLine operational anchor reference.

`findByEntry(entryId: string): Promise<NoShowDeterminationRecord | null>`
```javascript
prisma.noShowDeterminationRecord.findUnique({ where: { entryId } })
```
Used by: `NoShowService.determineNoShow()` — idempotency guard: if a record already exists for this entry, the worker exits without re-applying the determination. `entryId` has `@unique` constraint — one determination per entry.

**Indexed fields:**
- `entryId` — covered by `@unique` constraint

**Mutation rule:** Immutable from creation. Created by FOM at S5 on no-show determination. Not amendable. One record per entry enforced at schema level by `@unique` on `entryId`. Readable at S9 for post-closure audit.

---

### 7.2.4 Rate and Pricing
```

**Note:** After applying CR-01, update the model count declaration in Part 2 header and Part 7 header from 76 to 77 where stated.

---

## CR-02 — F8-01 — InquiryService wrong policy numbers

**Status:** APPLIED (2026-05-12) — both sub-edits applied verbatim.
**Priority:** DEFER (safe; mismatch visible to SIG writer cross-referencing Part 5)
**File:** DEV-SPEC-001-Part6.md
**Location:** §6.5.2 InquiryService — Policy enforcement points section
Also fix inline reference in Responsibilities prose (line referencing "Policy 6" and "Policy 8")

### CR-02-A — Responsibilities prose

**Current text:**
```
- Manages custodian assignment: assigns the initial custodian at inquiry creation; enforces the ownership assignment policy (Policy 6) at reassignment.
- Enforces the duplicate detection policy (Policy 8) at inquiry creation and before S4 confirmation.
```

**Replace with:**
```
- Manages custodian assignment: assigns the initial custodian at inquiry creation (Policy 3); enforces the custodian reassignment policy (Policy 4) at reassignment.
- Enforces the duplicate detection policy (Policy 12) at inquiry creation and before S4 confirmation.
```

### CR-02-B — Policy enforcement points block

**Current text:**
```
**Policy enforcement points in this service:**
- Policy 6 (Ownership / Custodian Assignment) — `InquiryService.assignCustodian()`
- Policy 8 (Duplicate Detection at Creation) — `InquiryService.create()`
```

**Replace with:**
```
**Policy enforcement points in this service:**
- Policy 3 (Initial Custodian Assignment Policy) — `InquiryService.create()`
- Policy 4 (Custodian Reassignment Policy) — `InquiryService.assignCustodian()`
- Policy 12 (Duplicate Inquiry and Entry Creation Gate Policy) — `InquiryService.create()`
```

---

## CR-03 — F8-02 — EntryService wrong and non-existent policy numbers

**Status:** APPLIED (2026-05-12) — Option A wording applied (references existing Policy 6/13; entry parking surfaced as §71 mutation-rule governed, not a Part 5 numbered policy). If the Architect later decides Option B (create dedicated Entry Expiry / Entry Parking policies in Part 5), revisit this entry.
**Priority:** DEFER (safe; non-existent policies will surface as questions at SIG stage)
**File:** DEV-SPEC-001-Part6.md
**Location:** §6.5.3 EntryService — Policy enforcement points section

**Current text:**
```
**Policy enforcement points in this service:**
- Policy 1 (Availability Query) — `EntryService.searchAvailability()` (delegates to `AvailabilityService`)
- Policy 8 (Duplicate Detection at Multi-Booking) — `EntryService.confirmReservation()` at S4
- Policy 13 (Entry Expiry) — enforced by `EntryExpiryWorker`; `EntryService.expireEntry()` called by worker
- Policy 14 (Parking) — `EntryService.park()`, `EntryService.unpark()`
```

**Replace with:**
```
**Policy enforcement points in this service:**
- Policy 1 (Availability Query) — `EntryService.searchAvailability()` (delegates to `AvailabilityService`)
- Policy 13 (Multi-Booking Detection Policy) — `EntryService.confirmReservation()` at S4
- Policy 6 (Inquiry Expiry Policy) — entry-level expiry governed by the same policy; enforced by `EntryExpiryWorker`; `EntryService.expireEntry()` called by worker
- Entry parking and unparking — governed by §71 mutation rules, not a numbered Part 5 policy; enforced at `EntryService.park()` and `EntryService.unpark()`
```

**Note:** This applies Option A (reference existing policy coverage; no new Part 5 policies created). If the Architect later decides Option B is warranted — creating dedicated "Entry Expiry Policy" and "Entry Parking Policy" in Part 5 — this entry must be revisited.

---

## CR-04 — F8-03 — GuestProfileService wrong policy number and missing enforcement point

**Status:** APPLIED (2026-05-12) — both sub-edits applied verbatim. Policy 16/17/18 split now consistent across prose and enforcement-points block.
**Priority:** DEFER
**File:** DEV-SPEC-001-Part6.md
**Location:** §6.5.11 GuestProfileService — Responsibilities prose and Policy enforcement points section

### CR-04-A — Responsibilities prose

**Current text:**
```
- Enforces guest data governance at S6 (Policy 16 — Guest Identity Verification and Data Capture) and at S9 (Policy 17 — Guest Data Retention and Deletion). S6 verification creates a `VerificationEvent` on the profile record; S9 retention/deletion follows the configured retention policy.
```

**Replace with:**
```
- Enforces guest data capture governance at S6 (Policy 17 — Guest Data Capture Governance Policy). S6 verification creates a `VerificationEvent` on the profile record.
- Enforces guest data retention and deletion at S9 (Policy 18 — Guest Data Retention and Deletion Policy); retention/deletion follows the configured retention policy.
```

### CR-04-B — Policy enforcement points block

**Current text:**
```
**Policy enforcement points in this service:**
- Policy 16 (Guest Identity Verification) — `GuestProfileService.verifyIdentity()` at S6
- Policy 17 (Guest Data Governance and Retention) — `GuestProfileService.applyRetention()` at S9
```

**Replace with:**
```
**Policy enforcement points in this service:**
- Policy 16 (Guest Identity Verification Policy) — `GuestProfileService.verifyIdentity()` at S6
- Policy 17 (Guest Data Capture Governance Policy) — `GuestProfileService.recordVerification()` at S6
- Policy 18 (Guest Data Retention and Deletion Policy) — `GuestProfileService.applyRetention()` at S9
```

---

## CR-05 — F7-01 — Wrong engine name in Part 7 FocConfigurationModel annotation

**Status:** APPLIED (2026-05-12) — applied verbatim. `FocEngine` → `FOCValidationEngine`.
**Priority:** DEFER
**File:** DEV-SPEC-001-Part7.md
**Location:** §7.2.4, FocConfigurationModel, `findActiveByRatePlan` query specification "Used by" line

**Current text:**
```
Used by: `FocEngine` — FOC eligibility resolution for a given rate plan.
```

**Replace with:**
```
Used by: `FOCValidationEngine` — FOC eligibility resolution for a given rate plan.
```

---

## CR-06 — S7-01 — Wrong model name in Part 6 IncidentService primary entity declaration

**Status:** APPLIED (2026-05-12) — applied verbatim. `LostFoundRecord` → `LostAndFoundRecord`.
**Priority:** DEFER
**File:** DEV-SPEC-001-Part6.md
**Location:** §6.5.7 IncidentService — Primary entity line

**Current text:**
```
**Primary entity:** `IncidentRecord`, `LostFoundRecord`
```

**Replace with:**
```
**Primary entity:** `IncidentRecord`, `LostAndFoundRecord`
```

---

## CR-07 — S7-02 — Typographical error in Part 6 FolioService method name

**Status:** APPLIED (2026-05-12) — applied verbatim. `settleForlio()` → `settleFolio()`.
**Priority:** DEFER
**File:** DEV-SPEC-001-Part6.md
**Location:** §6.5.4 FolioService — Policy enforcement points, Policy 33 line

**Current text:**
```
- Policy 33 (Billing Model Settlement) — `FolioService.settleForlio()` at S8
```

**Replace with:**
```
- Policy 33 (Billing Model Settlement) — `FolioService.settleFolio()` at S8
```

---

## CR-08 — F9-01 — Missing RevalidationDeltaRecord model

**Status:** APPLIED (2026-05-12) — decision resolved by code-state evidence, not by Architect deliberation.
**Priority:** Was DEFER + blocked on Architect; now resolved.
**Files affected:** DEV-SPEC-001-Part2.md, DEV-SPEC-001-Part5.md, DEV-SPEC-001-Part7.md (Part 6 §6.5.13 already aligned).

**Resolution path (2026-05-12):**

When the register was written (2026-04-08), CR-08 framed the question as an open architectural decision. By 2026-05-12, code-state evidence shows the decision was already made and implemented:

- `prisma/schema.prisma` line 626 defines `model RevalidationDeltaRecord` — persisted, anchored to `ProcessingLockRecord` via `processingLockId` FK.
- Migration `20260418092031_init` (2026-04-18) created `revalidation_delta_records` table with FK constraint.
- `src/services/infrastructure/processing-lock.service.ts` rules R5/R6 + lines 671–720 write the record in the same transaction as the new ProcessingLockRecord on `reconfirm()`.

The architectural call documented in the spec now matches the code:
- **Persisted (not transient)** — operator audit-trail value.
- **Anchored to ProcessingLockRecord (Part 6 position)** — channel-agnostic; front-desk and phone reconfirmations place locks but have no draft communication record. Anchoring to the lock means the delta applies uniformly across all channels.

**Applied edits:**
- **Part 2 §2.13.2** — added `model RevalidationDeltaRecord` Prisma model after `processing_lock_records`, mirroring the schema-of-record fields (`processingLockId`, `availabilityChanged`, `deficientStatusChanged`, `pricingChanged`, three Json deltas, `createdAt`, `createdBy`).
- **Part 5 §5.2.31 Policy 71** — wording clarified: "anchored to the new lock record" replaces "attached to the draft communication record"; added note that drafts (where they exist) reference the delta via the lock.
- **Part 7 §7.2.11** — added `RevalidationDeltaRecordModel` query spec (findById, findByLock, findByActor); fields aligned to canonical model.
- **Part 6 §6.5.13** — no change needed; already says "attached to the new lock record as a `RevalidationDeltaRecord`".
- **Model counts** — Part 7 header table, §7.2 prose, §7.5 audit Step 2 target all bumped 77 → 78. Part 2 has no header count claim.

---

## Supplementary finding (2026-05-12) — Part 2 schema drift gap

While resolving CR-08, an audit of `@@map` directives surfaced a much larger spec-to-code gap than the register captured:

- **Prisma schema: 96 `@@map` tables**
- **Part 2 spec (post CR-01 + CR-08): 78 `@@map` tables → after operational drift back-fill: 88**
- **Original gap: 19 models** (CR-08 closed 1; the operational drift back-fill closed 10; 8 remain).
- **Plus 2 naming drifts**: `season_calendars` (Part 2) vs `season_calendar` (Prisma); `rate_plans` (Part 2) vs `rate_plan_registry` (Prisma).

### Operational drift back-fill — APPLIED (2026-05-12)

10 operational records back-filled into Part 2 + Part 7 with full Prisma definitions and query specs:

| Model | Part 2 section | Part 7 section |
|---|---|---|
| `pre_arrival_tasks` (PreArrivalTask) | §2.8.2 Work Order | §7.2.7 |
| `room_assignments` (RoomAssignment) | §2.3.2 Inventory | §7.2.2 |
| `room_inspection_records` (RoomInspectionRecord) | §2.3.2 Inventory | §7.2.2 |
| `key_return_records` (KeyReturnRecord) | §2.3.2 Inventory | §7.2.2 |
| `write_off_records` (WriteOffRecord) | §2.4.2 Financial | §7.2.3 |
| `billing_model_transition_records` (BillingModelTransitionRecord) | §2.4.2 Financial | §7.2.3 |
| `cancellation_disclosure_records` (CancellationDisclosureRecord) | §2.4.2 Financial | §7.2.3 |
| `vip_arrival_notification_events` (VIPArrivalNotificationEvent) | §2.7.2 Communication | §7.2.6 |
| `follow_up_task_records` (FollowUpTaskRecord) | §2.2.2 Entity Hierarchy | §7.2.1 |
| `amendment_event_records` (AmendmentEventRecord) | §2.2.2 Entity Hierarchy | §7.2.1 |

Model counts bumped Part 2 (now 88 `@@map`) and Part 7 (header table + §7.2 prose + §7.5 audit Step 2 all 78 → 88).

### Admin Console back-fill — APPLIED (2026-05-12)

8 Admin Console / setup-time records back-filled into Part 2 §2.17.2 + Part 7 §7.2.14. The Prisma schema's "Admin domain (outside atlas Part 7)" docblock comments were interpreted as "outside the operational atlas scope" — Part 2 §2.17 was already designed for exactly this class of record (RoomTypeRegistry, CommunicationTemplate, VipNotificationRoutingConfig etc. were already there).

| Model | Part 2 section | Part 7 section |
|---|---|---|
| `hotel_profile` (HotelProfile) | §2.17.2 | §7.2.14 |
| `departments` (Department) | §2.17.2 | §7.2.14 |
| `roles` (Role) | §2.17.2 | §7.2.14 |
| `role_permission_mappings` (RolePermissionMapping) | §2.17.2 | §7.2.14 |
| `role_session_configs` (RoleSessionConfig) | §2.17.2 | §7.2.14 |
| `ai_actor_identity` (AiActorIdentity) | §2.17.2 | §7.2.14 |
| `mode_configurations` (ModeConfiguration) | §2.17.2 | §7.2.14 |
| `communication_channel_configs` (CommunicationChannelConfig) | §2.17.2 | §7.2.14 |

### Naming drift resolution — APPLIED (2026-05-12)

Prisma side won both drifts. Part 2 `@@map` strings renamed to match the canonical schema:

| Was (Part 2) | Now (matches Prisma) |
|---|---|
| `@@map("rate_plans")` | `@@map("rate_plan_registry")` |
| `@@map("season_calendars")` | `@@map("season_calendar")` |

Part 7 `**Table:**` references updated to match. Prisma model class names (`RatePlan`, `SeasonCalendar`) and the TypeScript surface (`prisma.ratePlan.*`, `prisma.seasonCalendar.*`) were already aligned — only the @@map table names diverged.

### Schema drift gap — CLOSED (2026-05-12)

- **Prisma schema: 96 `@@map` tables**
- **Part 2 spec: 96 `@@map` tables** ✅
- **Naming drifts: 0** ✅

Final model counts bumped across Part 7 (header table, §7.2 prose, §7.5 audit Step 2 target): 78 → 88 (after operational back-fill) → 96 (after Admin Console back-fill). Part 2 has no header count claim — no-op there. Drift between Part 2 spec and Prisma schema has been fully reconciled as of this session.

---

## Editing Checklist

Apply corrections in this order to minimise risk of introducing inconsistencies:

- [x] CR-01-A — Part 2 §2.4.1 mutation rule prose addition (applied 2026-05-12)
- [x] CR-01-B — Part 2 §2.2.2 Entry model relation addition (no-op — already present 2026-05-12)
- [x] CR-01-C — Part 2 §2.4.2 NoShowDeterminationRecord model (deviated — kept canonical financial-closure design; deleted operational-detail duplicate; 2026-05-12)
- [x] CR-01-D — Part 7 §7.2.3 NoShowDeterminationRecordModel entry addition (applied with extended query set; 2026-05-12)
- [x] Update Part 2 header model count: 76 → 77 (no-op — Part 2 has no header count claim; 2026-05-12)
- [x] Update Part 7 header model count: 76 → 77 (applied to header table, §7.2 prose, §7.5 audit target; 2026-05-12)
- [x] CR-02-A — Part 6 §6.5.2 Responsibilities prose (applied 2026-05-12)
- [x] CR-02-B — Part 6 §6.5.2 Policy enforcement points block (applied 2026-05-12)
- [x] CR-03 — Part 6 §6.5.3 Policy enforcement points block (applied 2026-05-12, Option A wording)
- [x] CR-04-A — Part 6 §6.5.11 Responsibilities prose (applied 2026-05-12)
- [x] CR-04-B — Part 6 §6.5.11 Policy enforcement points block (applied 2026-05-12)
- [x] CR-05 — Part 7 §7.2.4 FocConfigurationModel Used by annotation (applied 2026-05-12)
- [x] CR-06 — Part 6 §6.5.7 Primary entity line (applied 2026-05-12)
- [x] CR-07 — Part 6 §6.5.4 Policy 33 method name (applied 2026-05-12)
- [x] CR-08 — Applied (2026-05-12); decision resolved by code-state evidence (persisted, anchored to ProcessingLockRecord). Supplementary 18-model gap finding recorded above.

---

*End of CORRECTIONS-REGISTER.md*
*Prepared by Claude (AI Architectural Partner)*
*08 April 2026*
*Apply corrections before locking Parts 2, 6, and 7 for code generation.*
