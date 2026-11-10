import type { PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";
import { toDecimal } from "../../lib/money.js";
import { chooseCancellationRule, daysBeforeArrival, policyInTerms, readCancellationPolicy, type CancellationRule } from "../../lib/cancellation-policy.js";
export { cancellationChargeOn, type CancellationRule } from "../../lib/cancellation-policy.js";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.max(0, Number(v));
  return 0;
}

/**
 * `cancellation.policyTiers` — the hotel's cancellation policy (read by lib/cancellation-policy.ts):
 * on or off, the flat amounts, and lines by days before arrival (a share of the advance paid or a
 * set amount). Lines saved before 2026-11-10 count hours to the check-in time.
 */
export type CancellationPolicyTiersConfig = {
  enabled?: unknown;
  sameDayPenaltyAmount?: unknown;
  preArrivalPenaltyAmount?: unknown;
  /** SIG-S6 Policy 35 — optional override for post-check-in early departure; falls back to `sameDayPenaltyAmount`. */
  postCheckInEarlyDeparturePenaltyAmount?: unknown;
  tiers?: Array<{ minDaysBeforeArrival?: unknown; minHoursBeforeCheckIn?: unknown; basis?: unknown; value?: unknown; penaltyAmount?: unknown }>;
};

/**
 * Policy 35 — which rule a cancellation before arrival pays (2026-11-10). In order:
 *   1. a charge of the booking's own on its terms;
 *   2. the policy the booking keeps from Set up (`terms.policy`) — the guest pays what they were told;
 *   3. the setting as it is now (a booking set up before the policy was kept).
 * The rule may be a share of the advance paid: `cancellationChargeOn` puts it on what was paid.
 */
export function computeS5PreArrivalCancellationPenalty(input: {
  now: Date;
  checkInDate: Date;
  /**
   * The hotel's check-in time on the arrival day (2026-11-10). Time left in hours (an older line) is
   * counted to it. Absent: the stored date.
   */
  checkInAt?: Date | null;
  frozenCancellationTerms: Record<string, unknown> | null | undefined;
  policyTiers: CancellationPolicyTiersConfig | null | undefined;
}): { rule: CancellationRule; hoursUntilCheckIn: number; daysBeforeArrival: number } {
  const anchor = input.checkInAt ?? input.checkInDate;
  const hoursUntilCheckIn = (anchor.getTime() - input.now.getTime()) / 3600_000;
  const days = daysBeforeArrival(input.now, input.checkInDate);
  const terms = input.frozenCancellationTerms ?? {};
  const fromTerms = num(
    (terms as any).sameDayPenaltyAmount ?? (terms as any).preArrivalPenaltyAmount ?? (terms as any).penaltyAmount,
  );
  if (fromTerms > 0) {
    return {
      rule: { basis: "AMOUNT", value: fromTerms, label: `The booking's own charge · Nu ${fromTerms}`, from: "BOOKING" },
      hoursUntilCheckIn,
      daysBeforeArrival: days,
    };
  }
  const kept = policyInTerms(terms);
  const rule = chooseCancellationRule(
    readCancellationPolicy(kept ?? input.policyTiers),
    { daysBeforeArrival: days, hoursUntilCheckIn },
    kept ? "BOOKING_TERMS" : "SETTING",
  );
  return { rule, hoursUntilCheckIn, daysBeforeArrival: days };
}

/** SIG-S6 Policy 35 — penalty for early departure after check-in (folio LIVE); uses dedicated config or falls back to same-day amount. */
export function computePostCheckInEarlyDeparturePenalty(input: { policyTiers: CancellationPolicyTiersConfig | null | undefined }): number {
  const cfg = input.policyTiers as Record<string, unknown> | null | undefined;
  const dedicated = num(cfg?.postCheckInEarlyDeparturePenaltyAmount);
  if (dedicated > 0) return dedicated;
  return num((input.policyTiers as CancellationPolicyTiersConfig | null | undefined)?.sameDayPenaltyAmount);
}

/** Sum of `PaymentDirection.IN` rows for the folio (advance payments). Used by Policy 35 cancellation and Policy 57 no-show penalty cap. */
export async function sumAdvancePaymentInTotalForFolio(prisma: PrismaClient, folioId: string): Promise<number> {
  const [paid, returned] = await Promise.all([
    prisma.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.IN }, _sum: { amount: true } }),
    prisma.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.OUT }, _sum: { amount: true } }),
  ]);
  // Net of money already gone back (2026-11-05). It counted money in alone, so cancelling after a
  // refund at Set up would have refunded the same money a second time and charged against it.
  const held = toDecimal(paid._sum.amount).sub(toDecimal(returned._sum.amount));
  // Round to 2dp via Decimal before coercing to number — protects against float drift when
  // a penalty is expressed as a % of this value further downstream.
  return Number((held.gt(0) ? held : toDecimal(0)).toFixed(2));
}

/** SIG invariant: penalty cannot exceed total advance payment collected (Policy 35 / Policy 57). */
export function capCancellationPenaltyAtAdvancePayment(rawPenalty: number, advancePaymentTotal: number): number {
  return Math.min(Math.max(0, rawPenalty), Math.max(0, advancePaymentTotal));
}

export function enforceReservationPresentForS5CancellationPolicy35(input: { reservation: unknown | null | undefined }) {
  if (input.reservation) return;
  throw new StageGateBlockedError("Reservation (commitment snapshot) required for S5 cancellation", "NO_RESERVATION");
}

export function enforceFolioPresentForS5CancellationPolicy35(input: { folio: unknown | null | undefined }) {
  if (input.folio) return;
  throw new StageGateBlockedError("Folio required for cancellation financial posting", "MISSING_FOLIO");
}
