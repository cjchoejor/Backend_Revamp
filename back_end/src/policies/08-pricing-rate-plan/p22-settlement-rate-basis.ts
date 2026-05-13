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
 * for stay nights must match `frozenRate × nightCount` within tolerance.
 * When **any** amendment exists, skip numeric reconciliation (schema does not carry machine-readable rate deltas).
 */
export function enforceRoomChargeSumMatchesFrozenRateBasis(input: {
  frozenRatePerNight: number;
  stayNightCount: number;
  totalRoomChargesInStayWindow: number;
  /** When true, skip numeric check (any amendment on record — deltas not structured in schema). */
  skipNumericReconciliation: boolean;
  relativeTolerance: number;
}) {
  if (input.skipNumericReconciliation) return;
  if (input.stayNightCount <= 0) return;
  if (!Number.isFinite(input.frozenRatePerNight) || input.frozenRatePerNight < 0) return;

  const expected = input.frozenRatePerNight * input.stayNightCount;
  const tol = Math.max(0.01, Math.abs(expected) * input.relativeTolerance);
  if (Math.abs(input.totalRoomChargesInStayWindow - expected) <= tol) return;

  throw new PolicyGateBlockedError(
    "SETTLEMENT_RATE_BASIS_MISMATCH",
    `Posted ROOM_CHARGE total for stay (${input.totalRoomChargesInStayWindow.toFixed(2)}) does not match frozen rate basis (${expected.toFixed(2)} = ${input.frozenRatePerNight.toFixed(2)} × ${input.stayNightCount} night(s))`,
  );
}
