import type { PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";
import { toDecimal } from "../../lib/money.js";

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.max(0, Number(v));
  return 0;
}

/** `cancellation.policyTiers` — flat amounts and/or hour-bucket tiers (SIG-S5 Policy 35). */
export type CancellationPolicyTiersConfig = {
  sameDayPenaltyAmount?: unknown;
  preArrivalPenaltyAmount?: unknown;
  /** SIG-S6 Policy 35 — optional override for post-check-in early departure; falls back to `sameDayPenaltyAmount`. */
  postCheckInEarlyDeparturePenaltyAmount?: unknown;
  tiers?: Array<{ minHoursBeforeCheckIn?: unknown; penaltyAmount?: unknown }>;
};

/**
 * Policy 35 — derive raw cancellation penalty from commitment snapshot (`Reservation.frozenCancellationTerms`)
 * first, then optional `cancellation.policyTiers` configuration.
 */
export function computeS5PreArrivalCancellationPenalty(input: {
  now: Date;
  checkInDate: Date;
  frozenCancellationTerms: Record<string, unknown> | null | undefined;
  policyTiers: CancellationPolicyTiersConfig | null | undefined;
}): { rawPenalty: number; hoursUntilCheckIn: number } {
  const hoursUntilCheckIn = (input.checkInDate.getTime() - input.now.getTime()) / 3600_000;
  const terms = input.frozenCancellationTerms ?? {};
  const fromTerms = num(
    (terms as any).sameDayPenaltyAmount ?? (terms as any).preArrivalPenaltyAmount ?? (terms as any).penaltyAmount,
  );
  if (fromTerms > 0) return { rawPenalty: fromTerms, hoursUntilCheckIn };

  const cfg = input.policyTiers;
  if (cfg && Array.isArray(cfg.tiers) && cfg.tiers.length > 0) {
    const sorted = [...cfg.tiers].sort(
      (a, b) => num(b.minHoursBeforeCheckIn) - num(a.minHoursBeforeCheckIn),
    );
    for (const t of sorted) {
      if (hoursUntilCheckIn >= num(t.minHoursBeforeCheckIn)) {
        return { rawPenalty: num(t.penaltyAmount), hoursUntilCheckIn };
      }
    }
    return { rawPenalty: 0, hoursUntilCheckIn };
  }

  const fromCfg = num(cfg?.preArrivalPenaltyAmount ?? cfg?.sameDayPenaltyAmount);
  return { rawPenalty: fromCfg, hoursUntilCheckIn };
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
  const paid = await prisma.paymentRecord.aggregate({
    where: { folioId, paymentDirection: PaymentDirection.IN },
    _sum: { amount: true },
  });
  // Round to 2dp via Decimal before coercing to number — protects against float drift when
  // a penalty is expressed as a % of this value further downstream.
  return Number(toDecimal(paid._sum.amount).toFixed(2));
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
