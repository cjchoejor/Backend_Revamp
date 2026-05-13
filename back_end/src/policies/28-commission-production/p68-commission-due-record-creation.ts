/**
 * Policy 68 — Commission-Due Record Creation Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Pure evaluator: determines whether a commission-due record is required.
 */
export function shouldCreateCommissionDueRecord(input: { hasAgentProfile: boolean; commissionRate: number | null | undefined }) {
  if (!input.hasAgentProfile) return false;
  const r = input.commissionRate;
  return r != null && Number.isFinite(Number(r)) && Number(r) > 0;
}

