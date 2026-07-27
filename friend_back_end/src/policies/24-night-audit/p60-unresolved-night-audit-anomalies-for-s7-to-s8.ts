import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S7 §1.3 “open obligations” surrogate: unresolved night-audit anomalies tied to the entry
 * block progression to checkout prep (S8).
 */
export function enforceNoUnresolvedNightAuditAnomaliesForS7ToS8(input: { unresolvedCount: number }) {
  if (input.unresolvedCount <= 0) return;
  throw new StageGateBlockedError(
    "Unresolved night audit anomalies for this entry block S7→S8",
    "NIGHT_AUDIT_ANOMALY_UNRESOLVED",
  );
}

/** Same anomaly gate at **S8→S9** (closure prep) per SIG-S8 follow-up matrix. */
export function enforceNoUnresolvedNightAuditAnomaliesForS8ToS9(input: { unresolvedCount: number }) {
  if (input.unresolvedCount <= 0) return;
  throw new StageGateBlockedError(
    "Unresolved night audit anomalies for this entry block S8→S9",
    "NIGHT_AUDIT_ANOMALY_UNRESOLVED",
  );
}
