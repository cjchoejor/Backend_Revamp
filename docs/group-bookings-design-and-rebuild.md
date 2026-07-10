# Group Bookings (§56) — Design & Rebuild Guide

> **Status: designed + built + verified, then REVERTED on 2026-07-09 at the user's request.**
> This document is the complete record so the feature can be rebuilt later. Nothing from this
> feature currently exists in the codebase or database — everything below describes what to
> re-create. Phases 1, 2, and 3 were fully built and verified end-to-end before reversal.

---

## 1. The problem this solves

A travel agent (or coordinator) books **multiple rooms for the same night(s)** under one request.
On the front desk, the operator needs to assign **several rooms**, but every room picker in the
desk workspace is **single-select** — you can only pick one room per booking. There was no way to
represent or operate a multi-room booking.

## 2. Why it's shaped the way it is (the key architectural decision)

Per **Canon Block 10 §56 (Group Booking Management)** — `docs/dev-spec/Canon_Block10_CrossStage_Second_REV2.2.md`:

> Group booking container (GRP reference), individual entries (ENT references, **one per
> accommodation unit**), group member records (joins individual to group, carries billing mode
> and assignment)... — §56 M.9

The spec models a group as a **container + one `Entry` per room** ("member"), **NOT** multiple
rooms on a single Entry. Each room is its own Entry so it can diverge independently (early
departure, room change, dispute). `Segment` is unrelated — it is the re-entry layer (one per pass
through the stages), not a multi-room concept.

**Consequence for the room-picker problem:** the existing single-room `assignRoom` service and the
single-room pickers are *correct per member*. "Select multiple rooms" becomes a **rooming-list
grid** — N member rows, each with its own single-room picker — rather than making
`RoomAssignment` multi-room (which would ripple into pricing, folio, checkout, housekeeping).

Timing is flexible per §56 M.8: rooms can be assigned **early** (at S4, "early rooming list") or
**late** (at S5/S6, "late rooming list").

## 3. Relevant spec sections (§56 M.8 stage impact)

- **S1**: Group inquiry created. Expected room count + composition captured. Multiple contacts
  (agent = commercial counterparty, coordinator = operational contact).
- **S2**: Rate negotiated for the group (volume bands). FOC entitlement calculated. Quotation
  reflects group terms.
- **S3**: Committed hold on the **full room block**. Advance payment per group policy.
- **S4**: Confirmation covers the full group. Individual entries created at S4 (early rooming list)
  or deferred (late rooming list).
- **S5–S6**: Rooming list arrival + individual entry creation via the **bulk entry tool** (Excel/CSV
  upload, copy-paste from email, rapid manual entry). Identity verification per individual at S6.
- **S7**: Billing may be **CONSOLIDATED** (one folio), **INDIVIDUAL** (each own folio), or **SPLIT**.
  Billing-mode transitions permitted from S2 onward with **FOM authority + recorded reason**.
- **S8**: Group checkout (sequential or crowd checkout). Consolidated group bill reviewed by
  coordinator separately from individual settlements.
- **S9**: Group closure requires all member entries terminal. Commission-due for agent-mediated
  groups where the agent has a commission rate (§56 M.12).
- **FOC (§56 M.6)**: one FOC per ten rooms (or per contract).

## 4. Decisions taken with the user

- **Do it properly** — the full spec-faithful container model (not a lightweight shortcut).
- **All four capabilities**: multi-room intake + rooming list, group billing modes, bulk stage
  actions, bulk CSV/Excel import.
- **Flexible timing** (both early and late rooming list).
- **Extend the existing `/desk/bookings/[id]` workspace** (a group panel appears when the entry
  belongs to a group) — not a separate `/desk/groups` surface.
- **Assign rooms in the grid after creation** (late rooming list as the default).

---

## 5. Data model (all additive — no existing table altered destructively)

### New enums
```prisma
enum GroupBillingModeContainer { CONSOLIDATED  INDIVIDUAL  SPLIT }
enum GroupBookingStatus        { DRAFT  CONFIRMED  CLOSED  CANCELLED }
enum RoomingListSource         { MANUAL  PASTE  CSV }
```

### `GroupBooking` (the container, `GRP-YYYYMMDD-NNNN` readable id)
Fields: `id`, `inquiryId` (FK→inquiries), `displayName?`, `coordinatorName?`, `coordinatorContact?`,
`billingMode GroupBillingModeContainer @default(CONSOLIDATED)`, `expectedRoomCount Int`,
`focEntitlement Int @default(0)`, `status GroupBookingStatus @default(DRAFT)`, `travelAgentId?`
(FK→travel_agents), `corporateAccountId?` (FK→corporate_accounts), `masterFolioId?` (placeholder for
consolidated settlement), `notes?`, timestamps + `createdBy`, `confirmedAt?`, `closedAt?`, `closedBy?`.
Relations: `members Entry[] @relation("GroupBookingMembers")`, `roomingListUploads`,
`billingModeTransitions`. Indexes on `inquiryId`, `status`.

### `RoomingListUpload` (`RLU-…`, for Phase-4 bulk import)
`id`, `groupBookingId` (FK), `source RoomingListSource @default(MANUAL)`, `rowCount Int`,
`appliedCount Int @default(0)`, `rawPayload Json?`, `createdAt`, `createdBy`. Index on `groupBookingId`.

### `GroupBillingModeTransition` (billing-mode audit)
`id`, `groupBookingId` (FK), `fromMode GroupBillingModeContainer?`, `toMode GroupBillingModeContainer`,
`reason String`, `actorId String`, `createdAt`. Index on `groupBookingId`.

### `Entry` — one new nullable column
```prisma
groupBookingId String?   // FK → group_bookings, ON DELETE SET NULL, ON UPDATE CASCADE
groupBooking   GroupBooking? @relation("GroupBookingMembers", fields: [groupBookingId], references: [id], onUpdate: Cascade)
// + @@index([groupBookingId])
```
Note: `Entry.groupBillingMode` (existing enum `GroupBillingMode { GROUP_MASTER, INDIVIDUAL_FOLIO }`)
was previously **written but never read** (dormant). Phase 2 activates it as the per-member
designation.

### Reverse relations to add
- `Inquiry.groupBookings GroupBooking[]`
- `TravelAgent.groupBookings GroupBooking[]`
- `CorporateAccount.groupBookings GroupBooking[]`

### Readable-id prefixes (`back_end/src/lib/readable-id.ts`)
Add to `READABLE_ID_DEFAULT_PREFIXES` and `READABLE_ID_ENTITIES`:
`GROUP_BOOKING: "GRP"`, `ROOMING_LIST: "RLU"`.

### Migrations created (reverted)
- `20260709045319_group_bookings_container` — enums + 3 tables + `entries.groupBookingId`.
- `20260709052538_group_billing_mode_transitions` — the transition table.
Both were **purely additive** (CREATE TYPE / CREATE TABLE / ADD COLUMN nullable / ADD FK/INDEX).

---

## 6. Key constraints discovered (read before rebuilding)

1. **`Folio.entryId` is `@unique` and required** — a folio is strictly one-per-entry. There is **no
   consolidated-folio engine**. A real shared "master folio" would need schema + S7 charge-posting +
   S8 settlement surgery on the core money path. Phase 2 therefore did **not** re-plumb folios; it
   treated the "consolidated group bill" as a **read-time aggregation** (Σ member folio
   `outstandingBalance`).
2. **`assignRoom` is S5-gated and needs a committed hold** (`room-assignment-service.ts`). So inline
   room assignment in the grid only works once a member reaches Arrival (S5). Until then the grid
   shows the member's step + an Open link.
3. **Each member entry needs its OWN quotation (S2) and committed hold (S3)** to clear those gates.
   This is the biggest blocker to a smooth end-to-end group flow — bulk-advance stalls between
   S2–S4 because §56 wants ONE group quote + ONE block hold fanned out to members, which was **not
   built**. **This — group-level quote/hold — is the highest-value next piece, not CSV import.**
4. **`createEntry`** (`s1-entry-service.ts`) schedules per-entry expiry timers + dwell monitors +
   segment + audit. The group service reused it per member (correct), then set `groupBookingId` via a
   follow-up `entry.update`.

---

## 7. What was built, phase by phase (all reverted)

### Phase 1 — container + rooming-list grid + intake
**Backend**
- `back_end/src/services/domain/group-booking-service.ts`:
  - `createGroupBooking(prisma, actorId, actorLevel, { inquiryId, expectedRoomCount, displayName?,
    coordinatorName?, coordinatorContact?, billingMode?, notes?, memberDefaults?, createMembers? })`
    — creates the container (inherits `travelAgentId`/`corporateAccountId` from the inquiry),
    computes FOC (`floor(rooms/10)`), and (unless `createMembers:false`) creates N member entries
    each via `createEntry` then linked with `groupBookingId`. Requires `expectedRoomCount >= 2`.
  - `addGroupMembers(prisma, actor, actorLevel, groupBookingId, count, memberDefaults?)` — late
    additions; bumps `expectedRoomCount` and recomputes FOC.
  - `getGroupBooking`, `listGroupBookings`.
  - `computeFocEntitlement(roomCount)` = `floor(roomCount/10)`.
- `back_end/src/routes/group-bookings/router.ts` (L1+, mounted at `/api/group-bookings` in
  `api-router.ts`):
  - `GET /` (list, optional `?status=`), `POST /` (create), `GET /:id`, `POST /:id/members`.
- `back_end/src/dtos/21-group-bookings/request-schemas.ts` — zod schemas.
- `back_end/src/lib/entry-detail-include.ts` — added `groupBooking` include (container + member
  roster: guest, roomAssignments, and — Phase 2 — folio) so any member's `getEntry` drives the panel.

**Frontend**
- `front_end/src/lib/api/groups.ts` — client (`createGroupBooking`, `getGroupBooking`,
  `listGroupBookings`, `addGroupMembers`; Phase 2/3 added `setGroupBillingMode`, `bulkAdvanceGroup`).
- `front_end/src/types/api.ts` — `GroupBookingSummary`, `GroupMemberSummary`,
  `GroupBillingModeTransitionSummary`; `EntryDetail.groupBooking`/`groupBookingId`.
- `front_end/src/components/desk/inquiry/new-inquiry-form.tsx` — the "Group / MICE" channel reveals a
  **number-of-rooms + coordinator** block; on submit it creates the container (fans out N members)
  and opens member #1's workspace. `guestCountPerRoom = adults + children`.
- `front_end/src/components/desk/workspace/group-panel.tsx` — the **rooming-list grid**: container
  summary (coordinator, billing mode, FOC, rooms/assigned counts), one row per member (guest, step,
  assigned room OR inline single-room picker when the member is at S5, Open link), and an
  **Add-rooms** control. Rendered by `booking-workspace.tsx` when `entry.groupBooking` is set (added
  at the top of the canvas).

### Phase 3 — bulk stage actions
- `back_end/src/services/domain/group-bulk-service.ts`:
  - `bulkAdvanceGroup(prisma, actor, actorLevel, groupBookingId, targetStage, { keyCount? })` — moves
    every member currently at the **predecessor** stage one step forward, dispatching to the **same
    per-entry transition services the single-booking workspace uses**:
    - S2 → `progressS1ToS2` (`state-machines/s1-state-machine`)
    - S3 → `progressS2ToS3` (`state-machines/s2-s3-state-machine`)
    - S4 → `confirmReservation` (`services/domain/s4-confirmation-service`)
    - S5 → W4 activation (`workers/w4-pre-arrival-window-activation-worker` + `preArrivalService.initialiseTasks`)
    - S6 → `progressStageS5ToS6`, S7 → `progressStageS6ToS7`, S8 → `progressStageS7ToS8`
      (`state-machines/entry-lifecycle-state-machine`)
    - S9 → `progressStageS8ToS9` (`state-machines/s8-s9-state-machine`)
  - Returns `{ targetStage, advanced[], blocked[{id,reason}], skipped[], group }` — members failing a
    gate are reported with the reason, never silently skipped. `PREDECESSOR` maps each target to the
    stage a member must currently be at.
- Route: `POST /api/group-bookings/:id/bulk-advance` (L1+), DTO `bulkAdvanceGroupRequestSchema`
  (`targetStage: "S2".."S9"`, `keyCount?`).
- Frontend: group panel computes the **frontmost shared stage** among active members and shows an
  **"Advance all to <next step>"** button; toasts advanced/blocked counts.

### Phase 2 — billing modes + consolidated bill
- `setGroupBillingMode(prisma, actorId, groupBookingId, toMode, reason)` in
  `group-booking-service.ts`: requires a reason; records a `GroupBillingModeTransition`; updates
  `container.billingMode`; **propagates** to every member `Entry.groupBillingMode`
  (`CONSOLIDATED`/`SPLIT` → `GROUP_MASTER`, `INDIVIDUAL` → `INDIVIDUAL_FOLIO`).
- Route: `POST /api/group-bookings/:id/billing-mode` — **`requireActorLevel("L2")`** (FOM authority),
  DTO `setGroupBillingModeRequestSchema` (`billingMode`, `reason` required).
- Reads: `groupBookingInclude` + `entryDetailInclude` carry each member's `folio { id, state,
  outstandingBalance }` and the container's `billingModeTransitions` (take 10).
- Frontend: group panel shows the billing mode with a **Change** button (L2+ only) → a **reason
  modal** with the 3 modes; a **consolidated bill line** = Σ member folio `outstandingBalance`
  (framed as one group bill for CONSOLIDATED/SPLIT, per-room for INDIVIDUAL).
- **Boundary:** actual consolidated *settlement* (routing money into one master folio at S8) was NOT
  built — `masterFolioId` is a placeholder. Billing mode governs designation + presentation +
  settlement grouping only.

### Verification performed (all passed, then data cleaned up)
- Create inquiry → group of 3 → 3 linked member entries at S1; `getEntry` on a member carries the
  full roster.
- `addGroupMembers` +8 → 11 rooms, FOC recomputed to 1.
- `bulkAdvanceGroup` dispatches per member and reports honest per-member gate reasons.
- Billing: L1 change → 403; empty reason → 400; FOM (L2) change → mode updated, transition recorded,
  member `groupBillingMode` propagated both directions (INDIVIDUAL↔CONSOLIDATED).

---

## 8. What was NOT built (remaining work, in priority order)

1. **Group-level quote/hold** (highest value) — ONE quotation + ONE committed hold for the whole
   block, fanned out to members, so bulk-advance can clear S2/S3. Without this the group flow can't
   run smoothly end-to-end. Touches `s2-quotation-service`, `s3-hold-service`, and the S2/S3 gates.
2. **Phase 4 — bulk import** — CSV/Excel + copy-paste rooming list feeding `addGroupMembers`;
   `RoomingListUpload` already modelled (`source`, `rawPayload`, `appliedCount`). Rapid manual entry
   (tab between fields, auto-suggest from guest DB).
3. **Consolidated settlement at S8** — real master-folio money routing (needs the `Folio.entryId`
   unique constraint rethought, or a separate group-folio abstraction). + group closure requiring all
   members terminal + commission-due (§56 M.12).
4. **Corporate hierarchy-aware allocation** (§56 M.8 S5–S6) — CEO→suite, directors→deluxe, staff→
   standard: present rooms best→standard for corporate groups.

---

## 9. Rebuild order (mechanical)

1. Re-add schema (§5) → `npx prisma migrate dev --name group_bookings_container` then, for Phase 2,
   `--name group_billing_mode_transitions`. (Stop the dev server first on Windows — the tsx watcher
   locks `query_engine-windows.dll.node`; EPERM otherwise.)
2. Re-add readable-id prefixes.
3. Backend: `group-booking-service.ts`, `group-bulk-service.ts`, `dtos/21-group-bookings/`,
   `routes/group-bookings/router.ts`, mount in `api-router.ts`, extend `entry-detail-include.ts`.
4. Frontend: `types/api.ts`, `lib/api/groups.ts`, intake form group block, `group-panel.tsx`, render
   in `booking-workspace.tsx`.
5. Then tackle **group-level quote/hold** (§8.1) before Phase 4 — it's the real unlock.

Everything above was implemented and typechecked clean on branch `UI-experiment`; the git history of
this session (if kept) contains the exact code.
