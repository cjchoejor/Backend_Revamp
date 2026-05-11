import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 51 — DEFICIENT inspection / final status (SIG-S7→S8 slice).
 * Every deficient record on the occupied room must be RESOLVED or explicitly UNRESOLVED (carried to checkout).
 */
export function enforceDeficientRecordsHaveTerminalStatusForS7ToS8(input: { hasDeficientWithoutFinalStatus: boolean }) {
  if (!input.hasDeficientWithoutFinalStatus) return;
  throw new StageGateBlockedError("DEFICIENT condition missing final status", "DEFICIENT_NO_FINAL_STATUS");
}
