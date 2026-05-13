import { NightAuditRunStatus } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 61 — posting charges on a date sealed by a COMPLETE night audit is forbidden. */
export function enforceChargeDateNotSealedByCompleteNightAudit(input: {
  nightAuditRecord: { runStatus: NightAuditRunStatus } | null | undefined;
  operatingDateIso: string;
}) {
  if (input.nightAuditRecord?.runStatus !== NightAuditRunStatus.COMPLETE) return;
  throw new StateTransitionError("Charge date is sealed by completed night audit", "SEALED_AUDIT_DATE", {
    operatingDate: input.operatingDateIso,
  });
}
