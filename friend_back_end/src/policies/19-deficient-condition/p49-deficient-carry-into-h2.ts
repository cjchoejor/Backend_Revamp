import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 49 — DEFICIENT Carry into H2
 * SIG-S6: if room is DEFICIENT at H2 creation time, H2.deficientConditionStatus is mandatory.
 */
export function enforceDeficientCarryIntoH2(input: { isRoomDeficient: boolean; deficientConditionStatus: string | null | undefined }) {
  if (!input.isRoomDeficient) return;
  if (input.deficientConditionStatus != null && String(input.deficientConditionStatus).trim()) return;
  throw new PolicyGateBlockedError("H2_DEFICIENT_INCOMPLETE", "H2 with DEFICIENT room requires deficientConditionStatus");
}

