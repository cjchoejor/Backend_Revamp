# Multi-room bug hunt — status log

Started **2026-07-13**. Systematic sweep of every place in the codebase that assumed a booking has exactly one room. Each entry is either a confirmed bug (fixed) or verified as legitimately single-room-scoped by design (no fix needed).

Background: the multi-room selection model lives on `AvailabilityConfiguration.optionSelected` as one of three JSON shapes (legacy `{ roomId }`, whole-stay `{ roomIds: [...] }`, per-night `{ perNight: [...] }`). The reader helper [`option-selected-reader.ts`](../back_end/src/lib/option-selected-reader.ts) normalises all three. Multi-room bookings can happen below the group-detection threshold (default 6 guests), so classification must NOT be gated on `groupBillingMode === "GROUP_MASTER"` — number of distinct rooms is the correct signal.

Status legend: **Fixed** (was a real bug, patched) · **Not a bug** (verified single-room-by-design) · **Open** (still needs work).

## Multi-room persistence gaps in hold lifecycle

| # | Location | Bug | Status | Fix date |
|---|---|---|---|---|
| 1 | [`s3-hold-service.confirmCommittedHoldTx`](../back_end/src/services/domain/s3-hold-service.ts) | S4 confirmation only transitioned `hold.roomId` state; other multi-room rooms didn't move through claim-state sequence. | Fixed — iterates every held room via `allHeldRoomIds(hold)`, idempotent per room. | 2026-07-13 |
| 2 | [`s3-hold-service.releaseCommittedHoldForRoomChange`](../back_end/src/services/domain/s3-hold-service.ts) | Only released `hold.roomId`; other rooms stayed held after room-change. | Fixed — iterates all held rooms via the helper. | 2026-07-13 |
| 3 | [`s3-hold-service.releaseOnReEntry`](../back_end/src/services/domain/s3-hold-service.ts) | Only released `hold.roomId`; S6→S1 re-entry left other rooms held. | Fixed — iterates all held rooms via the helper. | 2026-07-13 |
| 4 | `s2-hold-service` speculative hold release | Suspected: only touched `hold.roomId` on release. | Not a bug — `SpeculativeHold` is single-room by schema (no `perNightBreakdown`); multi-room selection creates N rows, released independently. | 2026-07-13 |
| 5 | [`p40-s4-confirmation-readiness-gates`](../back_end/src/policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.ts) | Rejected `!input.hold.roomId`, wrongly blocking per-night holds where the room binding lives in `perNightBreakdown`. | Fixed — accepts either legacy `roomId` OR at least one `perNightBreakdown` entry as valid room binding. | 2026-07-13 |

## Multi-room pricing under-count in stay-charge math

| # | Location | Bug | Status | Fix date |
|---|---|---|---|---|
| 6 | [`compute-stay-charges.ts`](../back_end/src/services/infrastructure/compute-stay-charges.ts) | Multiplied nightly rate by nights only; multi-room bookings billed as if they were one room. | Fixed — signature extended to `computeStayCharges(nightlyRate, nights, roomCount = 1)`. Backwards compatible. | 2026-07-13 |
| 7 | [`s2-quotation-service`](../back_end/src/services/domain/s2-quotation-service.ts) | `Quotation.totalAmount = effectiveRate` — wildly under-priced multi-room bookings. | Fixed — reads `commercialTerms.roomCount` (falls back to `entry.numberOfRooms`); totalAmount = effectiveRate × roomCount. Applied at both `createQuotation` and `createGroupQuotation`. | 2026-07-13 |
| 8 | [`s4-confirmation-service`](../back_end/src/services/domain/s4-confirmation-service.ts) | Froze stay charge for one room only at confirmation. | Fixed — reads roomCount from accepted quotation's `commercialTerms.roomCount`. | 2026-07-13 |
| 9 | [`s9-service`](../back_end/src/services/domain/s9-service.ts) | Reconciled stay charge for one room only at post-stay. | Fixed — reads `commercialTerms.roomCount` (or falls back to `entry.numberOfRooms`). | 2026-07-13 |

## Multi-room state-machine gaps

| # | Location | Bug | Status | Fix date |
|---|---|---|---|---|
| 10 | [`entry-lifecycle-state-machine` S5→S6](../back_end/src/state-machines/entry-lifecycle-state-machine.ts) | Checked only first room's presence via `take: 1`. Multi-room progression needed all rooms verified. | Fixed — removed `take: 1`, dedups by roomId, enforces `enforceAssignedRoomPhysicalReadinessForArrival` + `enforceDeficientAssignmentDocumented` per room. Fail-fast if any isn't ready. | 2026-07-13 |
| 11 | [`entry-lifecycle-state-machine` S7→S8](../back_end/src/state-machines/entry-lifecycle-state-machine.ts) | Checked only first room's OCCUPIED state via `take: 1`. Multi-room progression needed all rooms OCCUPIED. | Fixed — removed `take: 1`, dedups by roomId, enforces `enforceOccupiedRoomAssignmentForS7ToS8` per room, queries `DeficientConditionRecord` across all rooms. | 2026-07-13 |

## Verified NOT bugs (single-room-by-design contexts)

| Location | Why it's fine |
|---|---|
| [`s7-amendment-service:73/79`](../back_end/src/services/domain/s7-amendment-service.ts) | Room-change amendment operates on ONE specific room the operator picked. |
| [`s8-checkout-service:25/28`](../back_end/src/services/domain/s8-checkout-service.ts) (`getEntryWithRoom` helper) | Used by `recordKeyReturn` + `recordInspection`, which are per-room operations by design. |
| [`entry-lifecycle-state-machine:200`](../back_end/src/state-machines/entry-lifecycle-state-machine.ts) (VIP notification) | Reads one room number for display only; notification itself is entry-level. |
| [`entry-lifecycle-state-machine:267`](../back_end/src/state-machines/entry-lifecycle-state-machine.ts) (S6→S1 room-change re-entry) | Takes the room being changed; single-room is correct. |

## Follow-ups (audit worth doing but not in scope of this pass)

| Location | Note |
|---|---|
| `getEntryWithRoom` (S8 helper) | Still uses `roomAssignments: take: 1`. Correct in its context (per-room operation), but worth revisiting if S8 grows batched flows. |
| `s7-amendment-service.roomChangeReEntryToS1` | Same — single-room-by-design, but flag if the amendment semantics ever change. |

## Related tracks

- Multi-room persistence downstream (schema + `RoomAssignment.startDate/endDate`, `CommittedHold.perNightBreakdown`): see CLAUDE.md → **Multi-room selection at S1 + per-night persistence**.
- Multi-room ≠ group (batched check-in/checkout, cancel-early-departure): see CLAUDE.md → **Group billing wiring** and the "multi-room ≠ group" fix.
