import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 12 — Duplicate Detection (SIG-S1 carry-forward).
 * S2→S3 exit: any inquiry duplicate flag in OPEN blocks progression.
 */
export function enforceNoOpenDuplicateFlagsForS2Exit(input: { duplicateFlags: Array<{ status?: string | null }> | null | undefined }) {
  const flags = input.duplicateFlags ?? [];
  const hasOpen = flags.some((f) => String(f.status ?? "") === "OPEN");
  if (!hasOpen) return;
  throw new PolicyGateBlockedError("DUPLICATE_UNRESOLVED", "Unresolved duplicate flag blocks exit");
}
