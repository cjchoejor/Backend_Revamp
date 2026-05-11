# LEGPHEL PMS — Stage Implementation Guideline
## S9: Post-Stay & Closure

**Document ID:** SIG-S9
**Version:** 1.0
**Derived from:** DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 5 REV2, 6 REV3, 8, 9 REV1, 12)
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT — Pending Architect confirmation
**Nothing in this document is locked until the Architect confirms.**

---

## Version History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 15 April 2026 | Claude (AI Architectural Partner) | Initial generation |

---

## Findings Register

Findings discovered during source loading that require MCL registration. Derived schemas are carried positively in the relevant sections below. No gap markers appear in the body of this document.

| ID | Type | Description | MCL Action |
|---|---|---|---|
| SIG-S9-COR-001 | NEW-CONTENT | `FollowUpTaskRecord` model absent from Part 2 REV2-FINAL. Referenced in Canon S9 charter (conference and group follow-up task) and in S9 required actions. No `model FollowUpTaskRecord { ... }` block exists in Part 2. Schema derived in §2.8 below. Part 2 backfill required. | Register PENDING |
| SIG-S9-COR-002 | NEW-CONTENT | `FolioState.WRITTEN_OFF` absent from `FolioState` enum in Part 2 REV2-FINAL. Session brief identifies WRITTEN_OFF as an expected terminal FolioState alongside SETTLED and OUTSTANDING. The enum currently carries: PROVISIONAL, LIVE, SETTLED, NO_SHOW_CLOSED, OUTSTANDING, CANCELLED, CANCELLED_REFUND_SETTLED. WRITTEN_OFF is absent. The write-off action must close the folio to a terminal state distinct from SETTLED (which implies full payment received) and OUTSTANDING (which implies active balance). Derived as `FolioState.WRITTEN_OFF` terminal value in §2.1 and §3 below. Part 2 backfill required. | Register PENDING |
| SIG-S9-COR-003 | NEW-CONTENT | `POST /entries/:id/close` route absent from Part 9 REV1. `EntryService.close()` is referenced in Policy 68 (commission-due record creation enforcement point) and Policy 70 (feedback solicitation enforcement point) in Part 5 REV2, and in Part 6 REV3 §6.5.3 (mutation rule: "close at S9"). The S9 terminal close action — distinct from `progress-stage` which moves the entry to the S9 stage — has no corresponding route in §9.4.4. Derived route at §8 below. Part 9 backfill required. | Register PENDING |
| SIG-S9-COR-004 | NEW-CONTENT | No invoice payment-state update route in Part 9 REV1. Canon §50.5 requires payment matching at S9 — payments received after checkout are matched against outstanding invoices, transitioning InvoiceState DISPATCHED → PAYMENT_TRACKED → RECONCILED. No route expressing `FolioService.recordPostStayPayment()` or an equivalent invoice state-progression call exists in §9.4.8. Derived as `POST /invoices/:id/record-payment-event` in §8 below. Part 9 backfill required. | Register PENDING |
| SIG-S9-COR-005 | NEW-CONTENT | No write-off route in Part 9 REV1. Canon §50.5 requires GM-authorised write-off of uncollectable balances. No `POST /folios/:id/write-off` route or equivalent exists in §9.4.8. Derived at §8 below. Part 9 backfill required. | Register PENDING |

---

## §1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 9 — Post-Stay & Closure (S9)**

### 1.2 Stage Purpose

Stage 9 exists to achieve final operational and financial closure of the guest engagement. Every open loop from the stay — outstanding invoices, unmatched payments, post-stay charges, unresolved disputes, deferred room inspections — must be closed, governed-outstanding, or written off before the engagement can be sealed. The engagement record, once sealed, becomes the hotel's permanent, immutable institutional record of the guest's experience from first inquiry to final closure.

S9 is the terminal stage. There is no stage that follows it. Every obligation carried out of S8 or arriving from no-show determination is resolved here. The record is then sealed, the inventory claim released, and the entry closed.

### 1.3 Entry Routes

**Route 1 — Forward from S8 (standard path)**

The S8→S9 transition executes when all five S8 exit conditions are satisfied: folio settled or in `FolioState.OUTSTANDING`; keys returned (`KeyReturnRecord` exists with `countReconciled = true` or reconciliation note); room in `DEPARTED_DIRTY` physical state; room inspection complete or governed-deferred; and dispute gate returning `CLEAR` at the S8→S9 evaluation. H5 is created or auto-fulfilled in the same transaction as the S8→S9 transition.

At S9 entry from S8, the system holds: the final folio with settlement record; any outstanding balance (if `FolioState.OUTSTANDING`); active disputes carried forward (all must have reached OPEN or IN_PROGRESS — none may be RESOLVED or CLOSED to have been carried; they continue through their independent lifecycle at S9); the H5 handoff (if residual obligations exist); the complete stay history; the guest profile; and the credit extension ceiling final status (for credit-extended entries).

The S8→S9 dispute gate invariant: at this transition the `DisputeGateEngine` returns `BLOCKED` (not `BLOCKED_WITH_OVERRIDE_AVAILABLE`) if any dispute is `OPEN` or `IN_PROGRESS`. No override path is available. The dispute must reach `RESOLVED` or `CLOSED` before the transition may proceed. This is categorically different from the S7→S8 gate where `BLOCKED_WITH_OVERRIDE_AVAILABLE` and the GM override path existed.

**Route 2 — No-show entry from S5 (direct financial closure path)**

An entry where no-show was formally confirmed at S5 arrives at S9 for financial closure. The financial consequences were determined at S5 through `NoShowService.determineNoShow()` and the folio was closed as `FolioState.NO_SHOW_CLOSED`. S9 for a no-show entry executes the financial record-keeping and seals the engagement.

Starting state at S9 for a no-show entry: `NoShowDeterminationRecord` sealed; folio in `FolioState.NO_SHOW_CLOSED`; advance payment disposition determined (retention, partial refund, or full refund). S9 confirms the disposition — invoice for retained penalty, refund record dispatch for partial or full refund — and closes the entry.

All S9 records for a no-show entry carry the `NoShowDeterminationRecord` as their operational anchor.

**Route 3 — Cancelled entries via S9-equivalent processing**

A confirmed reservation cancelled before arrival (at S4 or later, pre-S7) may require S9-level financial processing: refund dispatch, cancellation penalty invoice, or advance payment reconciliation. The cancellation mechanism governs the path; the financial closure executes at S9-equivalent processing. No separate stage progression is created for this path — it is an internal service consequence of cancellation. The entry reaches `EntryStatus.CLOSED` via `EntryService.close()` once all financial obligations are resolved.

### 1.4 Exit Condition

S9 exits to `EntryStatus.CLOSED` when the Loop Closure Invariant is satisfied. The invariant requires:

- All invoices dispatched (or scheduled per billing model)
- All payments matched — no received payment is unaccounted for against an invoice
- All disputes in terminal state (`RESOLVED` or `CLOSED`) — no dispute in `OPEN` or `IN_PROGRESS`
- All post-stay charges posted
- All financial obligations settled, in `FolioState.OUTSTANDING` with active follow-up, or written off with GM authority and recorded reason
- Feedback solicited through both channels (online platform encouragement and internal structured survey) — `W28` registered and `FEEDBACK.SOLICITATION_SENT` TraceEvent written
- For agent-mediated entries where agent profile has a commission rate configured: `CommissionDueRecord` created and complete (or `RATE_MISSING` escalation resolved)
- For conference and group entries: follow-up task created (`FollowUpTaskRecord` written)
- For government entries: `InvoiceState.PAYMENT_TRACKED` minimum (RECEIVED confirmation from FOM)
- For no-show entries: advance payment disposition confirmed (penalty invoice issued, refund dispatched, or full advance confirmed as refunded)
- H5 fulfilled or closed — no residual obligation handoff remains open
- `GuestDataRetentionWorker` timer registered at closure (Policy 18)

When all conditions above are satisfied, `EntryService.close()` transitions `EntryStatus` to `CLOSED`, seals the complete record, creates the `CommissionDueRecord` (configuration-activated), registers the feedback solicitation timer, sets the guest data retention timer, and emits `ENTRY_CLOSED` and `FOLIO_SEALED` TraceEvents.

S9 has no re-entry. Once `EntryStatus.CLOSED`, the engagement is terminal. Post-closure intervention (Level 2/3 additive access) does not re-open S9 — it adds records on top of the sealed archive.

### 1.5 Governing Actors

| Actor | Level | Governed actions at S9 |
|---|---|---|
| SYSTEM | L0 | Commission-due record creation; feedback solicitation dispatch; guest data retention timer registration; W8/W11/W27/W28/W29/W30 worker execution; folio sealing at entry closure |
| Front Desk | L1 | Invoice retrieval; handoff status review; entry and folio read access; H5 fulfilment confirmation (for settled obligations) |
| FOM | L2 | Post-stay charge posting (additive, L2 authority); credit note addition; commercial adjustment (with GM authority — see below); dispute progression; new dispute opening at S9; government payment RECEIVED confirmation; post-stay corrections (additive); close H5 after residual obligations resolved |
| GM | L3 | Dispute closure (mandatory recorded reason); write-off authorisation (mandatory recorded reason, maximum write-off amount per configuration band); commercial adjustment (mandatory authority); dispute REOPENED after CLOSED (mandatory reason) |

FOM manages the S9 process. GM closes disputes and authorises write-offs. Delegation of write-off and dispute closure is not permitted.

### 1.6 Forbidden Actions at S9

**Closing with any dispute in OPEN or IN_PROGRESS state.** The Loop Closure Invariant is violated. `EntryService.close()` raises `StageGateBlockedError` identifying the open dispute.

**Backdating post-stay entries.** All S9 records carry their actual transaction date (P-NEW-D). A damage charge posted one week after checkout is dated to the posting date. Night audit records from the stay period are sealed — they cannot be reopened or modified.

**Silently closing a dispute.** A dispute may be formally closed with `DisputeState.CLOSED` and a GM-recorded reason, but it may not silently disappear. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.

**Auto-closing an outstanding balance.** Outstanding balances do not expire or auto-resolve. They must be collected, credit-noted to zero (write-off), or explicitly written off with GM authority. A balance that ages into invisibility is a financial control failure.

**Modifying sealed folio lines or night audit records.** Corrections are additive only. The original folio line, charge record, or audit entry is permanently visible. The correction carries its own date.

**Producing a commission-due record when no commission rate is configured on the agent profile.** The commission obligation does not apply when no rate is configured. Producing a `CommissionDueRecord` in this case is forbidden.

**Closing an agent-mediated entry without a `CommissionDueRecord` when a commission rate IS configured.** When the agent profile carries a commission rate, the record is mandatory. Closure without it is an incomplete Loop Closure.

**Deleting or archiving records before formal closure.** Records are sealed on closure. Archival is a post-closure infrastructure concern — not an S9 operational action.

---

## §2 — Schema Models Active at S9

### 2.1 Folio

**Access type:** Read and terminal-state mutation at S9. Post-closure: Level 2/3 additive access only.

**S9-relevant fields:** `state FolioState` (transitions to terminal value at closure); `billingModel`; all `FolioLine` records; `PaymentRecord` set; `Invoice` set; `CreditNote` set.

**S9 `FolioState` terminal values:**

| Value | Meaning |
|---|---|
| `SETTLED` | All charges settled; balance zero; payment received in full |
| `OUTSTANDING` | Balance remains; active payment follow-up running (W8 registered) |
| `WRITTEN_OFF` | GM-authorised write-off of uncollectable balance; balance permanently visible; zero recoverable obligation (**derived — SIG-S9-COR-002; absent from Part 2 enum; backfill required**) |
| `NO_SHOW_CLOSED` | No-show path closure; set at S5 by NoShowService; immutable from creation |

**Mutation rule:** `Folio (Live)` — sealed at S9 closure; Level 2/3 additive layers only after sealing. Write-off transitions folio from `OUTSTANDING` to `WRITTEN_OFF` in the same transaction as the `WriteOffRecord` creation (L3 GM authority). Settlement of all outstanding obligations transitions from `OUTSTANDING` to `SETTLED`. A folio may not directly close to `SETTLED` while a balance remains — the write-off credit mechanism or payment receipt is required first.

### 2.2 FolioLine (Post-Stay Additive)

**Access type:** Created at S9 for post-stay charges (Level 2 FOM authority).

**S9-relevant fields:** `chargeType`; `amount`; `taxAmount`; `taxModel`; `description`; `postedAt` (actual transaction date — P-NEW-D, not stay date); `postedBy` (FOM actor — NOT NULL); `isPostStay Boolean` (must be `true` for all S9 additive entries); `folioId`.

**Mutation rule:** Immutable from creation. No `FolioLine` record is ever edited. Post-closure corrections are new `FolioLine` entries with their own date and a credit note if offsetting a prior line.

### 2.3 Invoice

**Access type:** Read and state progression at S9.

**S9-relevant fields and lifecycle:** `state InvoiceState` progresses through `DISPATCHED → PAYMENT_TRACKED → RECONCILED`. S9 begins with final invoice already dispatched at S8 (for guest-pay) or issued as proforma/final for direct-bill/government at S8 exit.

| InvoiceState | Transition trigger | Actor |
|---|---|---|
| `DISPATCHED` | Invoice sent to guest or corporate/government contact | L1 (via `FolioService.issueInvoice()`) |
| `PAYMENT_TRACKED` | Payment event received and matched against this invoice | L2 FOM (via `POST /invoices/:id/record-payment-event`) |
| `RECONCILED` | Bank statement confirms receipt (back-office accounting action) | L2 FOM |

**Government payment sufficiency rule:** `PAYMENT_TRACKED` (FOM marking as RECEIVED) is sufficient for engagement closure. `RECONCILED` is a post-closure accounting update that does not block S9 closure.

**Mutation rule:** `Invoice` is immutable after dispatch. Corrections are credit notes or adjustment entries — the original invoice is never modified.

### 2.4 CreditNote

**Access type:** Created at S9 where errors in the folio are discovered post-closure or where write-off offsets are applied.

**S9-relevant fields:** `folioId`; `invoiceId String?` (linked invoice if applicable); `amount`; `reason` (mandatory); `issuedBy` (L2+ actor); `issuedAt` (actual date — P-NEW-D); `createdAt`.

**Mutation rule:** Immutable from creation.

### 2.5 CommissionDueRecord

**Access type:** Created at S9 closure by SYSTEM (L0) when agent profile has a commission rate configured.

**Fields (from Part 2 REV2-FINAL §2.x):**

```
model CommissionDueRecord {
  id               String              @id @default(uuid())
  entryId          String
  agentProfileId   String
  commissionRate   Decimal             @db.Decimal(5,4)
  commissionBasis  String              // NET_ROOM_RATE | GROSS_ROOM_RATE | TOTAL_FOLIO
  calculatedAmount Decimal             @db.Decimal(15,2)
  currency         String              @default("BTN")
  status           CommissionDueStatus @default(PENDING)
  settledAt        DateTime?
  createdAt        DateTime            @default(now())
  createdBy        String              // L0 SYSTEM actor — NOT NULL

  entry            Entry               @relation(...)
  agentProfile     AgentProfile        @relation(...)

  @@map("commission_due_records")
}
```

**CommissionDueStatus values:** `PENDING` (rate configured, record created), `RATE_MISSING` (rate not configured — seam flag, not an error), `SETTLED` (commission paid outside PMS — manual update).

**Configuration-activated rule:** The `CommissionDueRecord` is created ONLY when the agent profile linked to the inquiry carries a configured `commissionRate`. When no commission rate is configured on the agent profile, no `CommissionDueRecord` is produced and S9 closure is not blocked by its absence. When `RATE_MISSING` — W11 registers to escalate to FOM within the configured resolution window.

**Mutation rule:** Immutable from creation. Level 3 additive correction permitted post-closure.

### 2.6 DisputeRecord (S9 terminal state)

**Access type:** Read and terminal-state transition at S9. New disputes may also be raised at S9 by FOM (Level 2).

**S9-relevant terminal states:** `RESOLVED` (guest accepted resolution; `ResolutionBundleStatus.SEALED`) or `CLOSED` (GM formal closure with mandatory recorded `closureReason`). No dispute in `OPEN` or `IN_PROGRESS` may remain at S9 engagement closure.

**Reopening rule:** A `CLOSED` dispute may be `REOPENED` by FOM or GM with mandatory reason. Reopening does not reopen the engagement — it adds a new dispute lifecycle layer on the closed entry per Level 2 post-closure access. `EntryStatus.CLOSED` is unchanged; the dispute carries `DisputeState.REOPENED`.

**Mutation rule:** Status transitions through lifecycle; sealed on `RESOLVED` or `CLOSED`; `ResolutionBundle` sealed simultaneously. `DisputeGateOverrideRecord` is immutable from creation.

### 2.7 HandoffRecord (H5 lifecycle at S9)

**Access type:** Read and closure at S9.

**H5 purpose:** Transfers residual financial obligations from front desk to accounts/reservations at S8 exit. H5 closes at S9 when all financial obligations are resolved.

**H5 closure trigger:** When the outstanding balance is settled (payment received and matched), written off (GM authority), or confirmed as requiring no further action, FOM fulfils H5 via `HandoffService.fulfil()`. H5 `HandoffRecord.state` transitions to `FULFILLED` then `CLOSED`.

**Auto-fulfilment rule:** Where no residual obligations exist at S8 exit, H5 is auto-fulfilled at S8 — `HandoffService` records the fulfilment for audit. At S9, these entries carry no active H5.

**No new handoffs at S9.** S9 is closure. H5 closes here. No new H-class handoffs are created at S9.

**Mutation rule:** `HandoffRecord` state transitions through CREATED → ASSIGNED → ACCEPTED → FULFILLED → CLOSED. The accepted and fulfilled events are immutable once written.

### 2.8 FollowUpTaskRecord (Derived — SIG-S9-COR-001)

`FollowUpTaskRecord` is absent from Part 2 REV2-FINAL. The following schema is derived from the S9 stage charter requirements (conference and group follow-up task creation) and the `TimerManagementService` pattern used throughout the system.

```
model FollowUpTaskRecord {
  // Created at S9 closure for conference and group entries.
  // FOM follow-up: relationship maintenance, service quality review, future booking cultivation.
  id             String   @id @default(uuid())
  entryId        String
  createdBy      String   // L0 SYSTEM actor at S9 closure — NOT NULL
  assignedTo     String?  // FOM actor ID assigned for follow-up
  dueAt          DateTime // governed by follow_up_task_deadline configuration
  completedAt    DateTime?
  completedBy    String?
  notes          String?
  createdAt      DateTime @default(now())

  entry          Entry    @relation(fields: [entryId], references: [id])

  // Mutation rule: created at S9 closure; completedAt/completedBy/notes mutable until completion.
  @@map("follow_up_task_records")
}
```

Back-relation on `Entry`: `followUpTasks FollowUpTaskRecord[]`.

**Part 2 backfill required (SIG-S9-COR-001).**

### 2.9 Entry (closure state)

**Access type:** Read throughout S9; terminal mutation at S9 closure.

**S9-relevant fields:** `status EntryStatus` (transitions to `CLOSED` at engagement closure); `currentStage` (remains `S9` until closed); `closedAt DateTime?` (set at closure); `version Int` (optimistic locking field per MC-011).

**Mutation rule:** Closed at S9 via `EntryService.close()`; sealed thereafter. Level 2/3 post-closure access is additive on linked records — the `Entry` record itself is immutable after `CLOSED`.

### 2.10 CommunicationRecord (Feedback Solicitation)

**Access type:** Created at S9 by W28 (FeedbackSolicitationWorker) — one per channel dispatched.

**S9-relevant fields:** `direction = OUTBOUND`; `channel` (EMAIL or WHATSAPP); `sendStatus`; `entryId`; `templateId`; `sentAt`.

W28 writes two `CommunicationRecord` rows per entry at S9 — one for the online platform encouragement channel and one for the internal structured survey channel. Both are required. One channel alone is insufficient.

**Mutation rule:** Immutable from creation.

---

## §3 — State Machine at S9

### 3.1 S9 Entry States

Three populations enter S9:

| Population | Folio state on entry | Active obligations |
|---|---|---|
| Standard departure (from S8) | `SETTLED` or `OUTSTANDING` | Outstanding balance follow-up; post-stay charges (if deferred inspection found damage); dispute continuation; invoice dispatch; feedback; commission-due |
| No-show (from S5 financial closure path) | `NO_SHOW_CLOSED` | Advance payment disposition confirmation; penalty invoice (if penalty retained); refund dispatch (if refund owed) |
| Cancelled pre-arrival (S9-equivalent) | `CANCELLED` or `CANCELLED_REFUND_SETTLED` | Cancellation invoice; refund dispatch where applicable |

### 3.2 Dispute Gate at S9 Closure

The dispute gate is evaluated at two points in S9:

**Point 1 — S8→S9 transition (entry into S9).** `DisputeGateEngine.canProgressStage()` is called by `EntryService.progressStage()`. Returns `BLOCKED` if any dispute is `OPEN` or `IN_PROGRESS`. No override. The dispute must reach `RESOLVED` or `CLOSED` before S8→S9 proceeds.

**Point 2 — S9 engagement closure (EntryService.close()).** Before closure, `DisputeService.evaluateStageGate()` evaluates all disputes on the entry. All must be `RESOLVED` or `CLOSED`. Any dispute in `OPEN`, `IN_PROGRESS`, or `REOPENED` causes `StageGateBlockedError`. S9 closure is blocked until all disputes are terminal.

There is no override path at S9 closure. Unlike S7→S8, where `BLOCKED_WITH_OVERRIDE_AVAILABLE` existed for certain dispute configurations, S9 closure has no override mechanism — the dispute must be formally concluded.

### 3.3 FolioState Terminal Transitions at S9

| Starting state | Triggering condition | Terminal state | Actor |
|---|---|---|---|
| `OUTSTANDING` | Payment received and matched; balance zeroed | `SETTLED` | L2 FOM (via payment match recording) |
| `OUTSTANDING` | GM authorises write-off; `WriteOffRecord` created | `WRITTEN_OFF` | L3 GM |
| `OUTSTANDING` | No further action required; balance governed-outstanding with active W8 | Remains `OUTSTANDING` until resolved | — |
| `SETTLED` | Already terminal at S8 | No change | — |
| `NO_SHOW_CLOSED` | Already terminal at S5 | No change | — |

A folio may not close to `SETTLED` with a remaining balance. Payment receipt or write-off is the mechanism. Auto-closure to `SETTLED` is forbidden.

### 3.4 EntryStatus.CLOSED Transition

`EntryStatus` transitions from `ACTIVE` (at stage S9) to `CLOSED` when `EntryService.close()` is invoked and all Loop Closure conditions are satisfied. The transition is atomic with:

- `CommissionDueRecord` creation (configuration-activated)
- `FeedbackSolicitationWorker` (W28) registration via `TimerManagementService`
- Guest data retention timer registration (`GuestDataRetentionWorker`) per Policy 18
- `FollowUpTaskRecord` creation (conference and group entries)
- Folio seal (`FOLIO_SEALED` TraceEvent)
- `ENTRY_CLOSED` TraceEvent with actor, timestamp, and closure evidence reference

### 3.5 Loop Closure Invariant — Open Loop Tabulation

Every open item must have an explicit resolution path before `EntryService.close()` may proceed. The invariant is enforced by the `close()` method itself — it does not proceed if any loop remains without a resolution path.

| Open loop type | Required resolution |
|---|---|
| Invoice not dispatched | Dispatch via `POST /folios/:id/invoices` or schedule per billing model |
| Payment received but unmatched | Match via `POST /invoices/:id/record-payment-event` |
| Outstanding balance (OUTSTANDING folio) | Receive payment (→ SETTLED), or write off (→ WRITTEN_OFF, GM authority) |
| Dispute in OPEN or IN_PROGRESS | Resolve (guest acceptance) or Close (GM authority + mandatory reason) |
| Post-stay charge obligation unposted | Post via `POST /folios/:id/charges` (L2) |
| Deferred room inspection incomplete | Inspection must be completed or lapse permanently recorded via W9 |
| CommissionDueRecord RATE_MISSING | Resolve via W11 escalation path within configured window |
| No-show advance payment disposition unconfirmed | Confirm via NoShowService S9 closure path |
| H5 not fulfilled | Fulfil via `POST /handoffs/:id/fulfil` after obligations resolved |
| FollowUpTaskRecord not created (conference/group) | Created atomically at `EntryService.close()` |
| Feedback not solicited | W28 registered atomically at `EntryService.close()` |

### 3.6 Record Sealing at Engagement Closure

On `EntryStatus.CLOSED`, the entire entry record is sealed:

- All `Segment` records → sealed (already sealed per prior stage exits; confirmed at closure)
- `Folio` → sealed (`FOLIO_SEALED` TraceEvent emitted)
- All `FolioLine` records → permanently immutable
- All `NightAuditRecord` records → already sealed per night; closure confirms permanence
- All `DisputeRecord`, `ServiceRecoveryRecord`, `ResolutionBundle` → sealed in terminal state
- All `HandoffRecord` → closed
- All `CommunicationRecord` → sealed
- All `StageDwellRecord` → sealed
- `CommissionDueRecord` → immutable from creation
- `FollowUpTaskRecord` → created at closure; mutable until completion

Post-closure access does not unseal any record. Level 2 (FOM) may add new records anchored to the closed entry. Level 3 (GM) may write corrections with own date. The sealed archive is never modified — only appended to.

### 3.7 Inventory Claim Release at S9

The `InventoryClaimState` for the room remains `CONFIRMED` throughout S8. At S9 engagement closure (`EntryService.close()`), the inventory claim is released. The room's claim state transitions to `FREE` in the same transaction as the S9 closure. This is the first point at which the room's date-range claim is released. A room in `DEPARTED_DIRTY` (physical state) with an S8-settled entry may not be reassigned until S9 closure completes and the inventory claim releases.

---

## §4 — Policy Envelope

### Policy 11 — Post-Stay Payment Follow-Up Policy

**Active at:** S9.
**Input:** `FolioState.OUTSTANDING`, last payment activity timestamp, configured follow-up interval sequence.
**Enforcement point:** `PaymentFollowUpWorker` (W8) — registered at invoice dispatch for `FolioState.OUTSTANDING` entries. Fires at each configured interval. Dispatches follow-up communications via `CommunicationService`.
**Hardcoded:** Follow-up is only dispatched for `FolioState.OUTSTANDING` entries. Entries with `FolioState.SETTLED` receive no follow-up. Outstanding balances may not be auto-closed, auto-written-off, or auto-settled by this worker — the worker escalates. Write-off requires GM authority.
**Configurable:** Follow-up interval sequence; escalation path (staff → FOM → GM); follow-up communication templates.

### Policy 18 — Guest Data Retention and Deletion Policy

**Active at:** S9 (post-closure).
**Input:** Entry closure timestamp; `GuestProfile` linked to the closed entry; configured retention period.
**Enforcement point:** `GuestDataRetentionWorker` (timer-fired) — registered at `EntryService.close()`; calls `GuestProfileService.applyRetention()`; deletion/anonymisation event recorded.
**Hardcoded:** Retention timer is always set at S9 closure. Deletion of governed personal data without a retention event is forbidden. Operational records (folio, charges, events) are not deleted — only personal identification data subject to the retention policy.
**Configurable:** Retention period duration per configuration surface.

### Policy 53 — Active Dispute Management Policy

**Active at:** S7–S9.
**Enforcement point:** `DisputeService.open()`, `DisputeService.progress()`. Disputes that continue into S9 remain under active SLA monitoring (W27). New disputes raised at S9 by FOM enter the same lifecycle. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.

### Policy 54 — Dispute Gate Stage Progression Policy

**Active at:** S8→S9 transition and S9 engagement closure.
**Enforcement point:** `EntryService.progressStage()` at S8→S9; `DisputeService.evaluateStageGate()` at `EntryService.close()`.
**At S8→S9:** Engine returns `BLOCKED` if any dispute is `OPEN` or `IN_PROGRESS`. No override.
**At S9 closure:** All disputes must be `RESOLVED` or `CLOSED`. `REOPENED` disputes block closure.
**Hardcoded:** No override path at S9. This differs from S7→S8 where `BLOCKED_WITH_OVERRIDE_AVAILABLE` existed.

### Policy 55 — Dispute Closure Policy

**Active at:** S9.
**Input:** `DisputeRecord` state; `ResolutionBundle` status; GM closure reason (if applicable).
**Enforcement point:** `DisputeService.close()` — GM authority verified; closure event recorded with actor, reason, and timestamp; `ResolutionBundle` sealed.
**Hardcoded:** GM closure requires a recorded reason (`closureReason` mandatory). A dispute cannot be closed without either guest acceptance (RESOLVED) or GM formal closure (CLOSED). `ResolutionBundle` is sealed on dispute closure — no further items may be committed after sealing.

### Policy 57 — No-Show Folio Financial Policy (S9 closure path)

**Active at:** S9 (no-show entry financial closure).
**Enforcement point:** `NoShowService` — S9 closure path confirms advance payment disposition: penalty invoice issued (if advance retained), refund dispatch confirmed (if partial or full refund owed), and entry proceeded to closure. All records carry the `NoShowDeterminationRecord` as operational anchor.
**Hardcoded:** Advance payment disposition must be confirmed before no-show entry closure. A no-show entry cannot close with an unresolved advance payment disposition.

### Policy 68 — Commission-Due Record Creation Policy

**Active at:** S9 (entry closure).
**Input:** Agent profile linked to the inquiry; commission rate configuration on the agent; entry's total qualifying revenue.
**Enforcement point:** `EntryService.close()` — `CommissionDueRecord` creation is a mandatory atomic step at S9 closure for entries with a linked agent profile where the profile carries a configured `commissionRate`. When no commission rate is configured, no `CommissionDueRecord` is produced and closure is not blocked.
**Hardcoded:** Commission-due record creation is automatic at closure — not a staff action. The record is created with `CommissionDueStatus.PENDING` when rate is configured, and `CommissionDueStatus.RATE_MISSING` when rate is not configured (seam flag preserved). When `RATE_MISSING`, W11 registers.
**Configurable:** Commission rate per agent profile; commission calculation basis rules.

### Policy 70 — Feedback Solicitation Policy

**Active at:** S9 (post-closure).
**Input:** Entry `EntryStatus.CLOSED`; guest communication channel preferences; feedback solicitation configuration; online review platform configuration.
**Enforcement point:** `EntryService.close()` — W28 (`FeedbackSolicitationWorker`) registered via `TimerManagementService` at closure; fires after configured post-checkout delay.
**Hardcoded:** Both channels required — online platform encouragement and internal structured survey. One channel alone is insufficient. Feedback solicitation is dispatched only for `EntryStatus.CLOSED` entries — cancelled, expired, and no-show entries are not solicited. Solicitation is the obligation; guest response is not a closure gate.
**Configurable:** Feedback survey templates; online review platform links; post-checkout delay duration.

---

## §5 — Engines at S9

### DisputeGateEngine

**Invoked at:** `EntryService.progressStage()` (S8→S9); `DisputeService.evaluateStageGate()` (S9 closure).
**Method:** `DisputeGateEngine.canProgressStage(input: DisputeGateInput): DisputeGateResult`
**S9 behaviour:**
- At S8→S9: returns `BLOCKED` if any `DisputeRecord` on the entry is `OPEN` or `IN_PROGRESS`. Returns `CLEAR` if all disputes are `RESOLVED` or `CLOSED`. `BLOCKED_WITH_OVERRIDE_AVAILABLE` is not returned at this transition.
- At S9 closure: returns `BLOCKED` if any dispute is `OPEN`, `IN_PROGRESS`, or `REOPENED`. Returns `CLEAR` if all disputes are terminal.

No other engines are invoked at S9. The pricing pipeline, tax engine, credit ceiling engine, and night audit engine are all S7/S8 concerns. S9 is a closure stage — no inventory query, pricing evaluation, or tax calculation occurs.

---

## §6 — Services at S9

### EntryService (S9 closure)

`EntryService.progressStage(entryId, targetStage: S9, transitionData, actorId)` — transitions entry from S8 to S9. Guards: all S8 exit conditions satisfied; dispute gate returns `CLEAR`. Writes `StageDwellRecord` for S8 (seals S8 dwell); opens S9 dwell. `H5HandoffRecord` created or auto-fulfilled in the same transaction.

`EntryService.close(entryId, actorId)` — terminal S9 action. Executes atomically:
1. Evaluates Loop Closure Invariant — raises `StageGateBlockedError` if any open loop lacks a resolution path
2. Calls `DisputeService.evaluateStageGate()` — all disputes must be terminal
3. Creates `CommissionDueRecord` (configuration-activated; L0 SYSTEM actor)
4. Registers W28 via `TimerManagementService` (`FEEDBACK_SOLICITATION` timer, post-checkout delay)
5. Registers `GuestDataRetentionWorker` via `TimerManagementService` (Policy 18)
6. Creates `FollowUpTaskRecord` (conference and group entries only)
7. Releases inventory claim (`InventoryClaimState` → `FREE`)
8. Transitions `Entry.status` → `CLOSED`; sets `Entry.closedAt`
9. Seals folio (`FOLIO_SEALED` TraceEvent)
10. Emits `ENTRY_CLOSED` TraceEvent

All steps execute in a single transaction. Partial closure is not permitted.

**Forbidden:** Calling `EntryService.close()` before all Loop Closure conditions are satisfied; creating a `CommissionDueRecord` when no commission rate is configured on the agent profile; releasing inventory claim before entry closure.

### FolioService (S9 operations)

`FolioService.postCharge(folioId, chargeData, actorId)` — Level 2 (FOM) post-stay charge posting. Enforces: `FolioLine.isPostStay = true`; `postedAt` carries actual transaction date (P-NEW-D, not stay date). Guest notification is a mandatory consequence of post-stay charge posting — `CommunicationService.dispatchPostStayChargeNotification()` called in the same transaction.

`FolioService.addCreditNote(folioId, creditNoteData, actorId)` — Level 2 additive correction. Original folio line is never modified. Credit note carries its own date.

`FolioService.issueInvoice(folioId, invoiceData, actorId)` — for post-stay billing where final invoice was not issued at S8 (government billing or post-stay charge scenarios).

`FolioService.recordPostStayPayment(folioId, paymentData, actorId)` — records payment events received after checkout. Matches against outstanding `Invoice`. Transitions `InvoiceState` DISPATCHED → PAYMENT_TRACKED when payment is confirmed received. When the matched payment brings the outstanding balance to zero, `FolioState` transitions from `OUTSTANDING` to `SETTLED` in the same transaction.

`FolioService.writeOff(folioId, writeOffData, actorId)` — L3 GM authority. Creates `WriteOffRecord` (see §2, derived below) with mandatory recorded reason; transitions `FolioState` from `OUTSTANDING` to `WRITTEN_OFF`; written-off amount remains permanently visible in the financial record and is not erased. Maximum write-off amount per authority level is enforced from the `write_off_authority_thresholds` configuration surface.

**Derived `WriteOffRecord` schema (pending SIG-S9-COR-002 Part 2 backfill):**
```
model WriteOffRecord {
  id           String   @id @default(uuid())
  folioId      String
  entryId      String
  amount       Decimal  @db.Decimal(15,2)
  currency     String   @default("BTN")
  reason       String   // mandatory — NOT NULL
  authorisedBy String   // GM actor — NOT NULL
  authorisedAt DateTime
  createdAt    DateTime @default(now())

  folio        Folio    @relation(fields: [folioId], references: [id])
  entry        Entry    @relation(fields: [entryId], references: [id])

  // Mutation rule: immutable from creation.
  @@map("write_off_records")
}
```

Back-relations on `Folio`: `writeOffRecords WriteOffRecord[]`. On `Entry`: `writeOffRecords WriteOffRecord[]`.

### HandoffService (H5 closure)

`HandoffService.fulfil(handoffId, fulfilmentEvidence, actorId)` — FOM fulfils H5 after residual financial obligations are resolved. `HandoffRecord.state` transitions to `FULFILLED`. Evidence carries the resolution basis (payment matched, write-off completed, or obligation confirmed no-action-required).

H5 does not close automatically. FOM must explicitly fulfil H5 via the governed path. H5 remains open until explicitly fulfilled — it is not auto-expired or auto-closed by timer.

### DisputeService (S9 terminal actions)

`DisputeService.close(disputeId, closureReason, actorId)` — L3 GM authority. Mandatory `closureReason` — service rejects the request if absent or empty. `DisputeRecord.state` transitions to `CLOSED`. `ResolutionBundle` sealed. `DisputeGateOverrideRecord` is not created at S9 (no override path exists).

`DisputeService.open(entryId, disputeData, actorId)` — L2 FOM opens new dispute at S9 (post-stay charge dispute, commission calculation dispute, invoice query). Dispute enters standard lifecycle.

`DisputeService.evaluateStageGate(entryId)` — called by `EntryService.close()` before closure. Returns `CLEAR` only when all disputes on the entry are `RESOLVED` or `CLOSED`. Returns `BLOCKED` otherwise.

### GuestProfileService (S9 data retention)

`GuestProfileService.applyRetention(profileId, closureTimestamp, actorId)` — called by `GuestDataRetentionWorker` (timer-fired, registered at S9 closure). Executes the deletion or anonymisation procedure for governed personal data past its retention period. The deletion/anonymisation event is permanently recorded. Operational records (folio, charges, audit events) are not deleted — only personal identification data subject to the retention policy.

### NoShowService (S9 closure path)

`NoShowService.processS9Closure(entryId, actorId)` — confirms advance payment disposition for no-show entries arriving at S9. Executes within a single transaction:
- If advance retained as penalty: penalty invoice issued; disposition confirmed
- If partial refund owed: refund `PaymentRecord` created (outgoing); dispatch confirmed
- If full advance refundable: full refund `PaymentRecord` created; dispatch confirmed
- `FolioState.NO_SHOW_CLOSED` remains unchanged (set at S5; immutable from creation)
- Entry proceeds to `EntryService.close()` after disposition confirmed

All records carry the `NoShowDeterminationRecord` as operational anchor.

### CommunicationService (S9 feedback and follow-up)

W28 calls `CommunicationService` to dispatch the dual-channel feedback solicitation. Two `CommunicationRecord` rows are written — one per channel (EMAIL, WHATSAPP). W8 calls `CommunicationService.dispatchFollowUp()` for payment follow-up communications at each configured interval.

---

## §7 — Workers at S9

### W8 — PaymentFollowUpWorker

**Governed stage(s):** S9
**Trigger:** Registered at invoice dispatch for `FolioState.OUTSTANDING` entries.
**Idempotency key:** `entryId` + interval number + `PAYMENT_FOLLOW_UP.INTERVAL_SENT` TraceEvent check.
**pg-boss job type:** `PAYMENT_FOLLOW_UP`
**Models read:** `Folio` (`state`), `Invoice` (`state`), `Entry` (`currentStage`), `GuestProfile` (contact), `CommunicationTemplate`, `TraceEvent` (idempotency)
**Models written:** `CommunicationRecord` (per interval), `TraceEvent` (`PAYMENT_FOLLOW_UP.INTERVAL_SENT`, `PAYMENT_FOLLOW_UP.ESCALATED`, `PAYMENT_FOLLOW_UP.SEQUENCE_EXHAUSTED`)
**Policies enforced:** Policy 11 — Post-Stay Payment Follow-Up Policy
**Config keys (dotted notation):** `payment.followUp.intervals`, `payment.followUp.escalationPath`, `payment.followUp.templateReference`
**Forbidden:** Auto-closing, auto-settling, or auto-writing-off outstanding balances. This worker escalates only.

---

### W9 — PostCheckoutInspectionReminderWorker

**Governed stage(s):** S8–S9 (carry-over from S8 deferral)
**Trigger:** Registered when inspection is deferred at S8 checkout.
**Idempotency key:** `entryId` + absence of completed inspection `TraceEvent`.
**pg-boss job type:** `POST_CHECKOUT_INSPECTION`
**Models read:** `Entry`, `Folio`, `TraceEvent` (inspection completion check)
**Models written:** `TraceEvent` (`POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED`, `POST_CHECKOUT_INSPECTION.FOM_ALERTED`)
**Config keys (dotted notation):** `inspection.postCheckout.windowDurationHours`
**Outcome on expiry:** FOM alerted; FOM decides between: damage charges posted as post-stay (via `FolioService.postCharge()`) or inspection permanently lapsed with recorded lapse event. The worker surfaces both outcomes — it does not choose.

---

### W11 — CommissionDueRateMissingEscalationWorker

**Governed stage(s):** S9
**Trigger:** Registered when a `CommissionDueRecord` is created with `CommissionDueStatus.RATE_MISSING`. Registers ONLY when a commission-due record is produced — i.e., only when a commission rate IS configured on the agent profile and the record is created with `RATE_MISSING` due to a calculation failure. When no commission rate is configured at all, no commission-due record is produced and this worker never registers.
**Idempotency key:** `CommissionDueRecord.id` + escalation phase.
**pg-boss job type:** `COMMISSION_RATE_MISSING_ESCALATION`
**Models read:** `CommissionDueRecord` (`status`, `agentProfileId`, `entryId`), `AgentProfile` (`commissionRate`), `Entry` (`currentStage`)
**Models written:** `TraceEvent` (`COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED`, `COMMISSION_DUE.GM_NOTIFIED`)
**Policies enforced:** Policy 68 — Commission-Due Record Creation Policy
**Config keys (dotted notation):** `commission.rateMissing.resolutionWindowSeconds`, `commission.rateMissing.gmNotificationThreshold`
**Idempotency guard:** Reads `CommissionDueRecord.status` before escalating; if `SETTLED`, skip.

---

### W27 — DisputeSLAWorker (S9 phase)

**Governed stage(s):** S7–S9
**S9 behaviour:** Continues SLA monitoring for disputes carried forward from S8 and for new disputes raised at S9. At S9, the SLA monitoring creates the conditions that determine whether the dispute gate will block engagement closure. Unresolved disputes escalate from staff → FOM → GM per configured escalation routing.
**Trigger:** Registered on `DisputeRecord` creation. Sub-behaviour: `ResolutionBundleItem` deadline monitoring.
**pg-boss job types:** `DISPUTE_SLA`, `RESOLUTION_EXECUTION`
**Config keys (dotted notation):** `dispute.sla.firstResponseSeconds`, `dispute.sla.resolutionSeconds`, `dispute.escalation.routingPerCategory`
**Idempotency guard:** Reads `DisputeRecord.state` — if `RESOLVED` or `CLOSED`, skip.
**Forbidden:** Creating `DISPUTE_EXHAUSTED` state. Closing disputes autonomously — escalation only.

---

### W28 — FeedbackSolicitationWorker

**Governed stage(s):** S9
**Trigger:** Registered at `EntryStatus.CLOSED` (via `EntryService.close()`). Fires after the configured post-checkout delay — NOT immediately at closure. The worker fires after the delay; feedback is not solicited in the same moment as closure.
**Idempotency key:** `Entry.id` + `FEEDBACK.SOLICITATION_SENT` TraceEvent check.
**pg-boss job type:** `FEEDBACK_SOLICITATION`
**Models read:** `Entry` (`status`), `GuestProfile` (`email`, `phone`, `preferences`), `FeedbackSurveyTemplate` (active template for EMAIL and WHATSAPP)
**Models written:** `CommunicationRecord` (one per channel — two rows per entry minimum), `TraceEvent` (`FEEDBACK.SOLICITATION_SENT` — carries `entryId`, `channelsDispatched`, `surveyTemplateId`, `sentAt`)
**Policies enforced:** Policy 70 — Feedback Solicitation Policy
**Config keys (dotted notation):** `feedback.solicitation.delaySeconds`, `feedback.survey.templates`, `feedback.platform.links`, `government.submission.config`
**Hardcoded:** Both channels are attempted regardless of prior acknowledgement status. Cancelled, expired, and no-show entries are not solicited.

---

### W29 — EquipmentReturnWorker (S9 phase)

**Governed stage(s):** S7–S9
**S9 behaviour:** For conference and catering entries with equipment allocations, the worker continues monitoring return deadlines into S9. Equipment allocated for an event must be returned within the governed return window. Deadline breach at S9 alerts FOM.
**Trigger:** Registered at `EquipmentAllocation` or `AssetAllocation` creation.
**pg-boss job type:** `EQUIPMENT_RETURN`
**Config keys (dotted notation):** `equipment.return.warningOffsetSeconds`, `equipment.return.escalationRouting`
**Idempotency guard:** Reads `EquipmentAllocation.returnConfirmedAt` — if confirmed, skip.

---

### W30 — LostFoundRetentionWorker (S9+ scope)

**Governed stage(s):** S9+ — governs `LostAndFoundRecord` records regardless of entry stage.
**Trigger:** Registered at `LostAndFoundRecord` creation.
**Idempotency key:** `LostAndFoundRecord.id` + retention phase.
**pg-boss job type:** `LOST_FOUND_RETENTION`
**Models read:** `LostAndFoundRecord` (`returnStatus`, `retentionExpiresAt`, `description`, `guestProfileId`)
**Models written:** `LostAndFoundRecord` (`returnStatus → DISPOSED`, `disposedAt`); `TraceEvent` (`LOST_FOUND.RETENTION_APPROACHING`, `LOST_FOUND.RETENTION_EXPIRED`, `LOST_FOUND.DISPOSAL_RECORDED`)
**Config keys (dotted notation):** `lostFound.retention.periodDays`, `lostFound.retention.warningOffsetDays`
**Idempotency guard:** Reads `LostAndFoundRecord.returnStatus` — if `RETURNED` or `DISPOSED`, skip.
**Note:** This worker is not strictly an S9 worker — it operates on `LostAndFoundRecord` records regardless of the entry's current stage. It is included here because its primary firing context is post-stay (S9+). The worker does not physically dispose of items — it records the disposal event and alerts responsible staff.

---

**Worker numbering confirmation:** W34 = AdvancePaymentFollowUpWorker; W35 = QuotationAckWorker. Neither is an S9 worker. No S9 worker is numbered W34 or W35.

---

## §8 — Routes at S9

### 8.1 Stage Progression: S8→S9

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` (S8→S9 requires standard FOM review at transition point) |
| Request DTO | `ProgressStageRequestDTO` (path param: `id`; body: `targetStage: "S9"`, `version: integer` — **required per MC-011 for optimistic locking**) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | Policy 51 — DEFICIENT Inspection Review Policy; Policy 54 — Dispute Gate Stage Progression Policy; Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (dispute gate returns BLOCKED; inspection not complete or deferred; folio not SETTLED or OUTSTANDING), `PolicyGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

**Notes:** The `version` field in `ProgressStageRequestDTO` is mandatory per MC-011. The S8→S9 dispute gate returns `BLOCKED` (not `BLOCKED_WITH_OVERRIDE_AVAILABLE`) if any dispute is OPEN or IN_PROGRESS — a request to the dispute gate override endpoint at this transition is rejected with `PolicyGateBlockedError`.

---

### 8.2 Entry Close (Terminal S9 Action)

*Derived — SIG-S9-COR-003. No corresponding route exists in Part 9 REV1. Backfill required.*

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/close` |
| Auth | `L2+` (FOM initiates; system validates Loop Closure Invariant) |
| Request DTO | `CloseEntryRequestDTO` (path param: `id`) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.close()` |
| Policies | Policy 54 — Dispute Gate (all disputes terminal required); Policy 68 — Commission-Due Record Creation; Policy 70 — Feedback Solicitation; Policy 18 — Guest Data Retention |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (Loop Closure Invariant violated — body identifies specific open loop), `PolicyGateBlockedError`, `StateTransitionError`, `AppError` |
| Pagination | No |

**Notes:** This route triggers the full closure sequence: Loop Closure Invariant check, dispute gate evaluation, commission-due record creation, feedback solicitation registration, guest data retention timer registration, follow-up task creation (conference/group), inventory claim release, folio seal, and `ENTRY_CLOSED` TraceEvent. All steps are atomic in a single transaction.

---

### 8.3 Post-Stay Charge Posting

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/charges` |
| Auth | `L2+` (FOM authority — post-stay charge posting) |
| Request DTO | `PostChargeRequestDTO` (body: `chargeType`, `amount`, `description`, `isPostStay: true` — mandatory flag) |
| Response DTO | `FolioLineResponseDTO` |
| Service method | `FolioService.postCharge()` |
| Policies | None at policy level — post-stay charge posting authority enforced at auth layer (L2+ required) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (folio not in a state accepting post-stay charges), `AppError` |
| Pagination | No |

**Notes:** `isPostStay` must be `true` on all S9 additive charge entries. `postedAt` carries the actual transaction date (P-NEW-D) — not the original stay date. Guest notification is dispatched in the same transaction.

---

### 8.4 Invoice Dispatch / Issue Invoice

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `IssueInvoiceRequestDTO` |
| Response DTO | `InvoiceResponseDTO` |
| Service method | `FolioService.issueInvoice()` |
| Policies | Policy 52 — Communication Acknowledgement Tracking Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 8.5 List Invoices

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `ListInvoicesRequestDTO` (query: cursor, limit) |
| Response DTO | `InvoiceListResponseDTO` |
| Service method | `FolioService.listInvoices()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | Yes |

---

### 8.6 Record Post-Stay Payment Event (Invoice Payment Matching)

*Derived — SIG-S9-COR-004. No corresponding route exists in Part 9 REV1. Backfill required.*

| Field | Value |
|---|---|
| Method + Path | `POST /invoices/:id/record-payment-event` |
| Auth | `L2+` (FOM) |
| Request DTO | `RecordPaymentEventRequestDTO` (path param: `id`; body: `amount`, `paymentMethod`, `receivedAt`, `referenceNumber String?`, `proofAttachmentId String?`) |
| Response DTO | `InvoiceResponseDTO` |
| Service method | `FolioService.recordPostStayPayment()` |
| Policies | None at policy level |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (invoice not in DISPATCHED or PAYMENT_TRACKED state), `AppError` |
| Pagination | No |

**Notes:** Transitions `InvoiceState` DISPATCHED → PAYMENT_TRACKED on first payment event. If payment brings outstanding balance to zero, `FolioState` transitions OUTSTANDING → SETTLED in the same transaction. For government: this is the "RECEIVED" confirmation step — sufficient for engagement closure. `RECONCILED` is a subsequent accounting action that does not block closure.

---

### 8.7 Add Credit Note

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/credit-notes` |
| Auth | `L2+` |
| Request DTO | `AddCreditNoteRequestDTO` (body: `amount`, `reason` — mandatory, `invoiceId String?`) |
| Response DTO | `CreditNoteResponseDTO` |
| Service method | `FolioService.addCreditNote()` |
| Policies | Policy 24 — Mid-Stay Discount Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

### 8.8 Write-Off

*Derived — SIG-S9-COR-005. No corresponding route exists in Part 9 REV1. Backfill required.*

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/write-off` |
| Auth | `L3` (GM authority — mandatory) |
| Request DTO | `WriteOffRequestDTO` (path param: `id`; body: `amount`, `reason` — mandatory) |
| Response DTO | `FolioResponseDTO` |
| Service method | `FolioService.writeOff()` |
| Policies | Write-Off Policy (authority bands enforced from `write_off_authority_thresholds` configuration) |
| Error responses | `ValidationError`, `AuthorizationError` (actor not GM), `NotFoundError`, `PolicyGateBlockedError` (amount exceeds GM authority band), `StateTransitionError` (folio not OUTSTANDING), `AppError` |
| Pagination | No |

**Notes:** Creates `WriteOffRecord` with mandatory reason. Transitions `FolioState` OUTSTANDING → WRITTEN_OFF in the same transaction. Written-off amount remains permanently visible — it is not erased. Auto-write-off or delegation below GM is forbidden.

---

### 8.9 Close Dispute

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/close` |
| Auth | `L3` (GM authority — mandatory) |
| Request DTO | `CloseDisputeRequestDTO` (path param: `id`; body: `closureReason` — mandatory) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.close()` |
| Policies | Policy 55 — Dispute Closure Policy |
| Error responses | `ValidationError`, `AuthorizationError` (actor not GM), `NotFoundError`, `PolicyGateBlockedError` (closure reason missing or empty; dispute not in closeable state), `AppError` |
| Pagination | No |

**Notes:** `closureReason` is mandatory — the service rejects the request if absent or empty. `ResolutionBundle` is sealed on closure. `DisputeGateOverrideRecord` is NOT created at S9 (no override path at S9; override records only exist for S7→S8 overrides).

---

### 8.10 Fulfil Handoff (H5 Closure)

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/fulfil` |
| Auth | `L1+` |
| Request DTO | `FulfilHandoffRequestDTO` (body: `fulfilmentEvidence`) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.fulfil()` |
| Policies | Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (fulfilment evidence incomplete), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 8.11 Get Folio

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id` |
| Auth | `L1+` |
| Request DTO | `GetFolioRequestDTO` (path param: `id`) |
| Response DTO | `FolioDetailResponseDTO` |
| Service method | `FolioService.getFolio()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

## §9 — Configuration at S9

All keys expressed in dotted notation per the locked configuration key naming standard.

### S9_READINESS surfaces (blocking — S9 cannot operate without these)

| Surface (dotted key) | Type | Consequence if absent |
|---|---|---|
| `invoice.templates` (FINAL type) | Json | Post-stay invoice generation unavailable |
| `payment.followUp.intervals` (≥ 1 entry) | Json | Post-checkout payment follow-up events cannot be scheduled |
| `feedback.survey.templates` (≥ 1 active) | Json | Post-stay feedback dispatch unavailable |
| `feedback.platform.links` (≥ 1 active) | Json | Review platform links in post-stay communications unavailable |
| `government.submission.config` | Json | Government identity submission cannot execute |
| `identity.document.retentionPeriodDays` | Integer | Guest data retention policy cannot enforce at post-stay |
| `expiry.defaults` (S9 event types — feedback solicitation) | Json | Timer Engine cannot schedule feedback solicitation events |

### Commission surfaces (conditional — required only when commission feature activated)

Included in S9 readiness check only when at least one agent profile carries a configured commission rate. When no agent profile carries a commission rate, these surfaces are omitted from the S9 readiness check.

| Surface (dotted key) | Type | Consequence if absent (when commission activated) |
|---|---|---|
| `commission.rate.perAgentProfile` | Json | Commission calculation at S9 cannot execute — rate not defined |
| `commission.calculationBasis.rules` | Json | Commission basis not defined — commission amount cannot be computed |

### Runtime configuration keys at S9

| Key (dotted notation) | Type | Worker/Service | Purpose |
|---|---|---|---|
| `payment.followUp.intervals` | Json | W8 | Follow-up interval sequence and duration |
| `payment.followUp.escalationPath` | Json | W8 | Staff → FOM → GM escalation routing |
| `payment.followUp.templateReference` | String | W8 | Communication template identifier |
| `inspection.postCheckout.windowDurationHours` | Integer | W9 | Inspection deferral window before FOM alert |
| `commission.rateMissing.resolutionWindowSeconds` | Integer | W11 | Resolution window before first escalation |
| `commission.rateMissing.gmNotificationThreshold` | Integer | W11 | Second escalation threshold |
| `dispute.sla.firstResponseSeconds` | Integer | W27 | Time-to-first-response SLA target |
| `dispute.sla.resolutionSeconds` | Integer | W27 | Time-to-resolution SLA target |
| `dispute.escalation.routingPerCategory` | Json | W27 | Per-category escalation routing |
| `feedback.solicitation.delaySeconds` | Integer | W28 | Post-checkout delay before feedback dispatch |
| `feedback.survey.templates` | Json | W28 | Survey templates per channel |
| `feedback.platform.links` | Json | W28 | Review platform links per booking source |
| `government.submission.config` | Json | W28 | Government portal submission parameters |
| `equipment.return.warningOffsetSeconds` | Integer | W29 | Warning lead time before return deadline |
| `equipment.return.escalationRouting` | Json | W29 | Escalation routing on breach |
| `lostFound.retention.periodDays` | Integer | W30 | Retention period before disposal |
| `lostFound.retention.warningOffsetDays` | Integer | W30 | Warning lead time before retention expiry |
| `writeOff.authority.thresholds` | Json | FolioService | Authority bands (max amount per level) |

---

## §10 — Acceptance Criteria

All criteria are pass/fail testable assertions. Criteria are grouped by concern.

### Schema

**AC-S9-001:** `CommissionDueRecord` exists in the database for any entry where the linked agent profile carried a configured `commissionRate` at the time `EntryService.close()` was called.

**AC-S9-002:** No `CommissionDueRecord` exists for any entry where the linked agent profile had no configured `commissionRate` at the time of closure.

**AC-S9-003:** All `FolioLine` records written at S9 carry `isPostStay = true` and a `postedAt` date equal to the actual transaction date — not any date within the original stay period.

**AC-S9-004:** No `FolioLine` record written at S9 carries a `postedAt` date that matches a date during the guest's stay (backdating is forbidden).

**AC-S9-005:** `FollowUpTaskRecord` exists for every conference and group entry that reached `EntryStatus.CLOSED`. No `FollowUpTaskRecord` exists for accommodation-only or catering-only entries that were not conference or group classified.

**AC-S9-006:** `WriteOffRecord` exists for every entry where `FolioState.WRITTEN_OFF` is the terminal folio state. No `WriteOffRecord.reason` field is null or empty.

**AC-S9-007:** `Entry.closedAt` is populated on all entries with `EntryStatus.CLOSED`. `Entry.closedAt` is never populated on entries not in `CLOSED` status.

### State Machine and Invariants

**AC-S9-008:** Calling `POST /entries/:id/progress-stage` with `targetStage: "S9"` on an entry with any `DisputeRecord` in `OPEN` or `IN_PROGRESS` state returns `StageGateBlockedError`. The transition does not proceed.

**AC-S9-009:** Calling `POST /entries/:id/close` on an entry with any `DisputeRecord` in `OPEN`, `IN_PROGRESS`, or `REOPENED` state returns `StageGateBlockedError`. The closure does not proceed.

**AC-S9-010:** Calling `POST /entries/:id/close` when any Loop Closure Invariant condition is unsatisfied returns `StageGateBlockedError` identifying the specific open loop type. The closure does not proceed.

**AC-S9-011:** Calling `POST /entries/:id/close` when all Loop Closure conditions are satisfied succeeds with `EntryStatus.CLOSED` in the response.

**AC-S9-012:** A folio with `FolioState.OUTSTANDING` and a zero balance cannot exist — a balance of zero with OUTSTANDING state is a state integrity violation. Either payment has been received (→ SETTLED) or a write-off has zeroed the balance (→ WRITTEN_OFF).

**AC-S9-013:** `FolioState.SETTLED` may only be set when the folio balance is zero from payment receipt. Auto-setting SETTLED while a balance remains returns `StateTransitionError`.

**AC-S9-014:** The `DisputeGateOverrideRecord` mechanism is not available at S8→S9 or at S9 closure. A request to `POST /disputes/override` at S8→S9 returns `PolicyGateBlockedError`. No override record is created at these points.

**AC-S9-015:** Once `EntryStatus.CLOSED`, the entry cannot re-enter any stage. `POST /entries/:id/progress-stage` on a CLOSED entry returns `StateTransitionError`.

**AC-S9-016:** `InventoryClaimState` for the room transitions to `FREE` in the same transaction as `EntryStatus.CLOSED`. No room with an active `CONFIRMED` claim has a corresponding entry in `CLOSED` status.

### Loop Closure Invariant

**AC-S9-017:** No entry reaches `EntryStatus.CLOSED` with an `Invoice` in `CREATED` state (not dispatched). An undispatched invoice blocks closure.

**AC-S9-018:** No entry reaches `EntryStatus.CLOSED` with a payment received event that has not been matched against an invoice.

**AC-S9-019:** No entry reaches `EntryStatus.CLOSED` with `FolioState.OUTSTANDING` unless either: (a) active W8 is running with at least one follow-up interval remaining, or (b) the balance has been written off (→ WRITTEN_OFF). An OUTSTANDING folio with no active W8 and no write-off record blocks closure.

**AC-S9-020:** No entry reaches `EntryStatus.CLOSED` with a deferred room inspection (`RoomInspectionRecord.isDeferred = true`) where the inspection window has not resolved — either a completed inspection record exists or a permanent lapse event has been recorded.

### Commission-Due Record (Both Cases Testable)

**AC-S9-021:** When `AgentProfile.commissionRate` is `null` or absent for the agent linked to the inquiry, `EntryService.close()` completes without creating a `CommissionDueRecord`. Closure is not blocked.

**AC-S9-022:** When `AgentProfile.commissionRate` is populated, `EntryService.close()` creates a `CommissionDueRecord` with `status = PENDING` in the same transaction. Closure is blocked if the record cannot be created.

**AC-S9-023:** When `AgentProfile.commissionRate` is configured but the calculation fails (ambiguous basis), `CommissionDueRecord` is created with `status = RATE_MISSING` and W11 is registered in the same transaction.

**AC-S9-024:** W11 fires at the configured resolution window after a `RATE_MISSING` `CommissionDueRecord` is created. W11 emits `COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED` TraceEvent.

**AC-S9-025:** W11 does not fire for entries where no `CommissionDueRecord` was produced (i.e., agent profile had no commission rate configured).

### Dual-Channel Feedback Solicitation

**AC-S9-026:** W28 fires after the configured `feedback.solicitation.delaySeconds` following `EntryStatus.CLOSED`. W28 does not fire immediately at closure.

**AC-S9-027:** W28 writes exactly two `CommunicationRecord` rows per entry — one for EMAIL and one for WHATSAPP. Fewer than two is insufficient and constitutes a policy violation.

**AC-S9-028:** `FEEDBACK.SOLICITATION_SENT` TraceEvent carries `channelsDispatched` field listing both channels. A TraceEvent with `channelsDispatched` containing only one channel is a policy violation.

**AC-S9-029:** W28 does not fire for entries with `EntryStatus.CANCELLED`, `EntryStatus.EXPIRED`, or entries that reached `EntryStatus.CLOSED` via the no-show path (`FolioState.NO_SHOW_CLOSED`).

**AC-S9-030:** W28 idempotency: if `FEEDBACK.SOLICITATION_SENT` TraceEvent already exists for an entry, W28 skips. No duplicate solicitation is sent on worker retry.

### Government Payment RECEIVED Sufficiency

**AC-S9-031:** For government billing entries, `EntryService.close()` succeeds when `InvoiceState.PAYMENT_TRACKED` (FOM-confirmed RECEIVED). `InvoiceState.RECONCILED` is not required for closure.

**AC-S9-032:** After closure, a separate `POST /invoices/:id/record-payment-event` call can transition `InvoiceState` from `PAYMENT_TRACKED` to `RECONCILED` as a post-closure accounting action. This does not reopen the entry or change `EntryStatus`.

### No-Show Entry S9 Path

**AC-S9-033:** A no-show entry (`FolioState.NO_SHOW_CLOSED`) with advance payment retained as penalty has a corresponding penalty invoice created at S9 before closure.

**AC-S9-034:** A no-show entry with a refund obligation has a corresponding refund `PaymentRecord` (outgoing) confirmed before closure.

**AC-S9-035:** All S9 records for a no-show entry carry a reference to the `NoShowDeterminationRecord` as operational anchor. No S9 record for a no-show entry lacks this reference.

### Post-Stay Charges

**AC-S9-036:** `POST /folios/:id/charges` with `isPostStay = false` or missing is rejected with `ValidationError` when the folio has been through S8 settlement.

**AC-S9-037:** A post-stay charge posting triggers a guest notification `CommunicationRecord` in the same transaction. A post-stay charge without a corresponding notification is a policy violation.

### Write-Off Authority

**AC-S9-038:** `POST /folios/:id/write-off` with an actor below `L3` (GM) returns `AuthorizationError`.

**AC-S9-039:** `POST /folios/:id/write-off` with a blank or absent `reason` returns `PolicyGateBlockedError`.

**AC-S9-040:** `POST /folios/:id/write-off` with an amount exceeding the GM authority band configured in `writeOff.authority.thresholds` returns `PolicyGateBlockedError`.

**AC-S9-041:** After write-off, the original balance amount remains permanently readable in the `WriteOffRecord`. The `FolioState` is `WRITTEN_OFF`. The financial record is not erased.

### Record Sealing and Post-Closure Access

**AC-S9-042:** After `EntryStatus.CLOSED`, no existing `FolioLine` record can be modified via any service method. An attempt to edit an existing line returns `StateTransitionError`.

**AC-S9-043:** After `EntryStatus.CLOSED`, a Level 2 (FOM) actor can create a new `FolioLine` record via `POST /folios/:id/charges` (L2 additive access). The new record carries an actual post-closure date.

**AC-S9-044:** After `EntryStatus.CLOSED`, `FOLIO_SEALED` TraceEvent exists on the entry. `ENTRY_CLOSED` TraceEvent exists with closure timestamp and actor.

**AC-S9-045:** `Entry.version` field is present in `ProgressStageRequestDTO` for the S8→S9 progress-stage call. A call without `version` returns `ValidationError`.

### H5 Handoff Lifecycle

**AC-S9-046:** No entry reaches `EntryStatus.CLOSED` with an H5 `HandoffRecord` in `CREATED`, `ASSIGNED`, or `ACCEPTED` state. H5 must be `FULFILLED` or auto-fulfilled before closure.

**AC-S9-047:** Entries where settlement was complete at S8 (no residual obligations) have H5 in `FULFILLED` state with an auto-fulfilment `TraceEvent`. No active H5 obligation exists for these entries at S9.

### Use Type Variations

**AC-S9-048:** For conference and group entries reaching `EntryStatus.CLOSED`, `FollowUpTaskRecord` exists with `entryId` matching the entry and `dueAt` set within the configured follow-up deadline window.

**AC-S9-049:** For apartment entries reaching `EntryStatus.CLOSED`, if a security deposit was held, a `PaymentRecord` (outgoing) for the deposit return exists (net of any deductions) or a written record of zero-balance deposit exists before closure.

**AC-S9-050:** For catering entries with equipment allocated, `EquipmentAllocation.returnConfirmedAt` is populated before closure, or W29 has emitted `EQUIPMENT_RETURN.DEADLINE_BREACHED` and a FOM resolution event is recorded.

---

*SIG-S9 v1.0 — Draft*
*Produced by: Claude (AI Architectural Partner)*
*Authority: SESSION-BRIEF-SIG-S9 v1.0 (locked by Architect)*
*Sources: Canon Block 8 §50; DEV-SPEC-001 Parts 0, 2 REV2-FINAL, 5 REV2, 6 REV3, 8, 9 REV1, 12; MASTER-CORRECTION-LOG v2.2*
*Architect: Dhendup Cheten, Fuzzy Automation*
*Status: DRAFT — Nothing is locked until the Architect confirms.*
