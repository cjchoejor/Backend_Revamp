import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 12 — Duplicate Detection (SIG-S1 exit).
 * OPEN duplicate flags block S1→S2 (same blockingCondition as S2 path; S1 uses stage gate envelope).
 */
export function enforceNoOpenDuplicateFlagsForS1Exit(input: { duplicateFlags: Array<{ status?: string | null }> | null | undefined }) {
  const flags = input.duplicateFlags ?? [];
  const hasOpen = flags.some((f) => String(f.status ?? "") === "OPEN");
  if (!hasOpen) return;
  throw new StageGateBlockedError("Unresolved duplicate flag blocks S1 exit", "DUPLICATE_UNRESOLVED");
}
