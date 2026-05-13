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

**Priority:** BLOCK
**Files affected:** DEV-SPEC-001-Part2.md (3 sub-changes), DEV-SPEC-001-Part7.md (1 sub-change)

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

## CR-08 — F9-01 — Missing RevalidationDeltaRecord model (requires architectural decision first)

**Priority:** DEFER — and blocked on Architect decision
**Files affected:** DEV-SPEC-001-Part2.md, DEV-SPEC-001-Part5.md, DEV-SPEC-001-Part6.md, DEV-SPEC-001-Part7.md

**Decision required before this correction can be written:**

1. Is `RevalidationDeltaRecord` a persisted canonical record or a transient in-memory payload shown to the operator at reconfirmation time only?

2. If persisted: does it anchor to the new `ProcessingLockRecord` (Part 6 §6.5.13 position) or to the draft communication record (Part 5 §5.2.31 position)? Part 6 position is architecturally sounder.

**Pending correction (to be specified once decision is made):**

- If persisted: add Prisma model to Part 2 (fields: `processingLockRecordId`, `availabilityDelta Json`, `pricingDelta Json?`, `deficientFlagChange Json?`, `revalidatedAt DateTime`, `actorId String`, `createdAt DateTime`); add model entry to Part 7; align attachment point description in Part 5 §5.2.31 and Part 6 §6.5.13.

- If transient: remove "a `RevalidationDeltaRecord` is created" language from both Part 5 §5.2.31 and Part 6 §6.5.13; replace with "the revalidation result is returned as a structured response payload to the operator before proceeding."

**Exact text locations (for when decision is made):**

Part 5 §5.2.31 Policy 71 — current text referencing RevalidationDeltaRecord:
> "a RevalidationDeltaRecord is created and attached to the draft communication record showing what changed during processing"

Part 6 §6.5.13 ProcessingLockService — current text referencing RevalidationDeltaRecord:
> "Results of revalidation are attached to the new lock record as a `RevalidationDeltaRecord`."

---

## Editing Checklist

Apply corrections in this order to minimise risk of introducing inconsistencies:

- [ ] CR-01-A — Part 2 §2.4.1 mutation rule prose addition
- [ ] CR-01-B — Part 2 §2.2.2 Entry model relation addition
- [ ] CR-01-C — Part 2 §2.4.2 NoShowDeterminationRecord model addition
- [ ] CR-01-D — Part 7 §7.2.3 NoShowDeterminationRecordModel entry addition
- [ ] Update Part 2 header model count: 76 → 77
- [ ] Update Part 7 header model count: 76 → 77
- [ ] CR-02-A — Part 6 §6.5.2 Responsibilities prose
- [ ] CR-02-B — Part 6 §6.5.2 Policy enforcement points block
- [ ] CR-03 — Part 6 §6.5.3 Policy enforcement points block
- [ ] CR-04-A — Part 6 §6.5.11 Responsibilities prose
- [ ] CR-04-B — Part 6 §6.5.11 Policy enforcement points block
- [ ] CR-05 — Part 7 §7.2.4 FocConfigurationModel Used by annotation
- [ ] CR-06 — Part 6 §6.5.7 Primary entity line
- [ ] CR-07 — Part 6 §6.5.4 Policy 33 method name
- [ ] CR-08 — Blocked; apply after architectural decision on RevalidationDeltaRecord

---

*End of CORRECTIONS-REGISTER.md*
*Prepared by Claude (AI Architectural Partner)*
*08 April 2026*
*Apply corrections before locking Parts 2, 6, and 7 for code generation.*
