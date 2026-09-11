import type { Prisma } from "@prisma/client";
import { FolioLineType } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { listStayNightOperatingDatesUtc } from "../24-night-audit/p61-night-audits-complete-for-stay-before-settlement.js";

function operatingDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

/** Policy 22 — every amendment in the chain must be explicitly approved (SIG §4.1 / §6.2). */
export function enforceApprovedAmendmentChainForSettlement(
  amendments: Array<{ authorisedBy: string | null; authorityBasis: string | null }>,
) {
  for (const a of amendments) {
    if (!a.authorisedBy?.trim() || !a.authorityBasis?.trim()) {
      throw new PolicyGateBlockedError(
        "AMENDMENT_NOT_APPROVED_FOR_SETTLEMENT",
        "Each AmendmentEventRecord must carry authorisedBy and authorityBasis before settlement",
      );
    }
  }
}

/** @deprecated Prefer `amendments.length > 0` to skip numeric basis until amendment deltas are structured. */
export function hasRateOrRoomAmendment(amendments: Array<{ amendmentType: string }>): boolean {
  return amendments.some((a) => /RATE|PRICE|ROOM|NIGHT/i.test(a.amendmentType ?? ""));
}

/** Sum **ROOM_CHARGE** lines whose operating `chargeDate` falls on a stay night (UTC). */
export function sumRoomChargesInStayWindowUtc(
  lines: Array<{ chargeDate: Date; lineType: FolioLineType; amount: Prisma.Decimal }>,
  checkIn: Date,
  checkOut: Date,
): number {
  const nightMillis = new Set(listStayNightOperatingDatesUtc(checkIn, checkOut).map((d) => d.getTime()));
  let sum = 0;
  for (const l of lines) {
    if (l.lineType !== FolioLineType.ROOM_CHARGE) continue;
    const op = operatingDateUtc(l.chargeDate);
    if (nightMillis.has(op.getTime())) sum += num(l.amount);
  }
  return sum;
}

/**
 * Policy 22 (narrow slice) — when **no** amendments exist on the entry, total posted **ROOM_CHARGE**
 * for stay nights must match the frozen basis within tolerance.
 *
 * Two bases (2026-08-17 — found live: a 3-room composition booking failed settlement because
 * the check compared 6 room-nights of room+meals against ONE room's room-only rate):
 *   - **Composition** (`compositionExpectedTotal` non-null): Σ `RoomAssignment.frozenSubtotal`
 *     — each room's frozen net stay total (room + meals), the exact figures the night audit
 *     divides per night. Multi-room and per-night splits reconcile by construction.
 *   - **Legacy flat** (null): `frozenRate × nightCount` — single-room bookings frozen before
 *     the per-room composition track.
 * When **any** amendment exists, skip numeric reconciliation (schema does not carry machine-readable rate deltas).
 */
export function enforceRoomChargeSumMatchesFrozenRateBasis(input: {
  frozenRatePerNight: number;
  stayNightCount: number;
  totalRoomChargesInStayWindow: number;
  /** When true, skip numeric check (any amendment on record — deltas not structured in schema). */
  skipNumericReconciliation: boolean;
  relativeTolerance: number;
  /** Σ RoomAssignment.frozenSubtotal when the booking has per-room composition; null = legacy. */
  compositionExpectedTotal?: number | null;
  /**
   * Σ the ACCOMMODATION half of the composition — room + extra bed, meals excluded (2026-09-11).
   *
   * The ledger legitimately carries two shapes. Before the split, one ROOM_CHARGE line per
   * night carried room AND meals together, so `compositionExpectedTotal` was the right
   * expectation. Since the night audit posts the meal plan as its own F&B line, Σ ROOM_CHARGE
   * is the accommodation alone. A folio can even hold both — audited across the change.
   *
   * So the check accepts EITHER basis. That is not a loosening: its job is to catch a room
   * billed at the wrong RATE, and both figures are frozen, neither is caller-supplied, and the
   * gap between them is the meals — which are still on the folio either way, just under a
   * different line type. Demanding one shape would refuse settlement on every booking audited
   * on the other side of the change.
   */
  compositionAccommodationTotal?: number | null;
}) {
  if (input.skipNumericReconciliation) return;
  const composition =
    input.compositionExpectedTotal != null &&
    Number.isFinite(input.compositionExpectedTotal) &&
    input.compositionExpectedTotal > 0;
  if (!composition) {
    if (input.stayNightCount <= 0) return;
    if (!Number.isFinite(input.frozenRatePerNight) || input.frozenRatePerNight < 0) return;
  }

  const expected = composition
    ? (input.compositionExpectedTotal as number)
    : input.frozenRatePerNight * input.stayNightCount;
  const within = (target: number) =>
    Math.abs(input.totalRoomChargesInStayWindow - target) <= Math.max(0.01, Math.abs(target) * input.relativeTolerance);
  if (within(expected)) return;
  // The accommodation-only basis — a folio whose meals are their own F&B line.
  const accommodation = input.compositionAccommodationTotal;
  if (
    composition &&
    accommodation != null &&
    Number.isFinite(accommodation) &&
    accommodation > 0 &&
    within(accommodation)
  ) {
    return;
  }
  const tol = Math.max(0.01, Math.abs(expected) * input.relativeTolerance);
  void tol;

  throw new PolicyGateBlockedError(
    "SETTLEMENT_RATE_BASIS_MISMATCH",
    composition
      ? `Posted ROOM_CHARGE total for stay (${input.totalRoomChargesInStayWindow.toFixed(2)}) does not match the frozen per-room composition basis (${expected.toFixed(2)} = Σ room frozen subtotals${
          accommodation != null && accommodation > 0 ? `, or ${accommodation.toFixed(2)} with the meal plan posted separately` : ""
        })`
      : `Posted ROOM_CHARGE total for stay (${input.totalRoomChargesInStayWindow.toFixed(2)}) does not match frozen rate basis (${expected.toFixed(2)} = ${input.frozenRatePerNight.toFixed(2)} × ${input.stayNightCount} night(s))`,
  );
}
