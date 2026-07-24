import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — operational inventory / equipment accountability (SIG-S9 closure slice).
 */
export function enforceEquipmentReturnResolvedForS9Closure(input: {
  allocation: { returnConfirmedAt: Date | null } | null | undefined;
  hasDeadlineBreachedTrace: boolean;
  hasResolvedTrace: boolean;
}) {
  if (!input.allocation || input.allocation.returnConfirmedAt) return;
  if (input.hasDeadlineBreachedTrace && input.hasResolvedTrace) return;
  throw new StageGateBlockedError("Equipment return not resolved", "EQUIPMENT_RETURN_NOT_RESOLVED");
}
