import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 57 — No-Show Folio Financial Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Invariants on derived amounts before automated no-show financial side-effects at S9.
 */
export function enforceNoShowFinancialAmountsNonNegative(input: { penalty: number; net: number }) {
  const { penalty, net } = input;
  if (Number.isFinite(penalty) && penalty >= 0 && Number.isFinite(net) && net >= 0) return;
  throw new PolicyGateBlockedError("NO_SHOW_FINANCIAL_INVALID", "No-show penalty and net position must be finite and non-negative");
}

