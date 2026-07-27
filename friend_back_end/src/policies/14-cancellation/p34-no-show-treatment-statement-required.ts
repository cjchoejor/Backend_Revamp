import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 34 — Cancellation Terms Disclosure Policy (S3).
 * SIG-S3: CancellationDisclosureRecord cannot be created without no-show treatment statement.
 */
export function enforceNoShowTreatmentStatementPresent(input: { noShowTreatmentStatement: string }) {
  if (input.noShowTreatmentStatement.trim()) return;
  throw new PolicyGateBlockedError("MISSING_NO_SHOW_TREATMENT", "noShowTreatmentStatement is required");
}

