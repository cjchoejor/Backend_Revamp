import { StageGateBlockedError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

export type DeficientRoomAcknowledgementInput = {
  acknowledgementActorId: string;
  acknowledgementAt: string;
  decisionTaken: string;
};

/**
 * Policy 48 — DEFICIENT Room Assignment Decision Policy
 * SIG-S5 §4 policy envelope; enforced at `RoomAssignmentService.assignRoom()`.
 */
export function requireDeficientRoomAcknowledgement(
  input: DeficientRoomAcknowledgementInput | null | undefined,
): { acknowledgementAt: Date } {
  if (!input?.acknowledgementActorId?.trim() || !input?.acknowledgementAt?.trim()) {
    throw new PolicyGateBlockedError(
      "DEFICIENT_ACKNOWLEDGEMENT_REQUIRED",
      "DEFICIENT room requires acknowledgement payload",
    );
  }

  const ackAt = new Date(input.acknowledgementAt);
  if (Number.isNaN(ackAt.getTime())) throw new ValidationError("Invalid acknowledgementAt datetime");

  return { acknowledgementAt: ackAt };
}

/** SIG-S5 exit condition: if deficientAtAssignment then acknowledgement fields must be populated. */
export function enforceDeficientAssignmentDocumented(input: {
  deficientAtAssignment: boolean;
  acknowledgementActorId: string | null | undefined;
  acknowledgementAt: Date | null | undefined;
}) {
  if (!input.deficientAtAssignment) return;
  if (input.acknowledgementActorId && input.acknowledgementAt) return;
  throw new StageGateBlockedError("DEFICIENT assignment lacks acknowledgement", "DEFICIENT_NOT_DOCUMENTED");
}

