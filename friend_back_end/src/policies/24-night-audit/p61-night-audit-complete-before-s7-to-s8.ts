import { NightAuditRunStatus } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 61 — Night audit (SIG-S7→S8 slice).
 * Last operating date before checkout must have a COMPLETE night audit run.
 */
export function enforceNightAuditCompleteForLastOperatingDateBeforeS7ToS8(input: {
  nightAudit: { runStatus: NightAuditRunStatus | string } | null | undefined;
}) {
  if (input.nightAudit?.runStatus === NightAuditRunStatus.COMPLETE) return;
  throw new StageGateBlockedError("Night audit must be COMPLETE for last operating date before checkout", "NIGHT_AUDIT_NOT_COMPLETE");
}
