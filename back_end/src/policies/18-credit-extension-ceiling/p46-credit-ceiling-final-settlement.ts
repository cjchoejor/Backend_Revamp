import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 46 — Credit ceiling final balance (SIG-S8 §4.1 / §6.2).
 * If outstanding exceeds the approved ceiling, FOM acknowledgement is required before settlement.
 */
export function enforceCreditCeilingFinalBalanceForSettlement(input: {
  outstanding: number;
  ceilingAmount?: number | null;
  fomAcknowledgementRef?: string | null;
  creditCeilingTier2AcknowledgedAt?: Date | null;
}) {
  const ceiling = input.ceilingAmount;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;
  if (input.outstanding <= ceiling) return;
  if (input.fomAcknowledgementRef?.trim()) return;
  if (input.creditCeilingTier2AcknowledgedAt) return;
  throw new PolicyGateBlockedError(
    "CEILING_EXCEEDED_FOM_ACKNOWLEDGEMENT_REQUIRED",
    "Outstanding exceeds approved credit ceiling — provide fomAcknowledgementRef or prior tier-2 acknowledgement",
  );
}

/**
 * Partial settlement authority (2026-08-24, operator ruling — the S3 advance rule at S8):
 * a guest leaving with the balance only partially paid is the hotel extending credit, so the
 * act carries FOM+ authority — either the settling operator IS L2+, or an FOM has recorded a
 * credit extension (unexpired, ceiling covering the remainder) that sanctions the departure.
 * The remainder then settles at S9 payment follow-up, the extension's expiry serving as the
 * pay-by date — read-time enforced like the S3 advance extension, no worker.
 *
 * NOT gated here by design: DIRECT_BILL settlements (outstanding-by-model — the company is
 * invoiced) and short-voucher settlements (the shortfall is invoiced to the agent).
 */
export function enforcePartialSettlementRequiresFomOrCreditExtension(input: {
  actorLevel: "L1" | "L2" | "L3" | "L4";
  /** What will still be owed after this settlement (scoped outstanding − paid now). */
  remainder: number;
  creditExtension: { ceilingAmount: number; expiresAt: Date | null } | null;
}): { sanction: "FOM_ACTOR" | "CREDIT_EXTENSION" } {
  if (!(input.remainder > 0)) return { sanction: "FOM_ACTOR" }; // defensive — callers gate on remainder > 0
  if (input.actorLevel !== "L1") return { sanction: "FOM_ACTOR" };
  const credit = input.creditExtension;
  if (!credit) {
    throw new PolicyGateBlockedError(
      "PARTIAL_SETTLEMENT_REQUIRES_FOM",
      `A partial settlement leaves ${input.remainder.toFixed(2)} owing — that needs FOM (L2+) authority, or an FOM-recorded credit extension covering the remainder.`,
    );
  }
  if (credit.expiresAt && credit.expiresAt.getTime() <= Date.now()) {
    throw new PolicyGateBlockedError(
      "PARTIAL_SETTLEMENT_REQUIRES_FOM",
      `The credit extension on file expired ${credit.expiresAt.toISOString()} — it no longer covers the ${input.remainder.toFixed(2)} remainder. An FOM has to re-approve it or settle this themselves.`,
    );
  }
  if (!(Number.isFinite(credit.ceilingAmount) && credit.ceilingAmount >= input.remainder)) {
    throw new PolicyGateBlockedError(
      "PARTIAL_SETTLEMENT_REQUIRES_FOM",
      `The credit extension ceiling (${credit.ceilingAmount.toFixed(2)}) does not cover the ${input.remainder.toFixed(2)} remainder — an FOM has to raise it or settle this themselves.`,
    );
  }
  return { sanction: "CREDIT_EXTENSION" };
}
