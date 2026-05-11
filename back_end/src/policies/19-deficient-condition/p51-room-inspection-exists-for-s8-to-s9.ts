import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 51 — DEFICIENT Inspection Review chain (SIG-S8 §3.2).
 * S8→S9: a `RoomInspectionRecord` must exist (deferral path is represented by the deferred inspection row + W9 in this slice).
 */
export function enforceRoomInspectionExistsForS8ToS9(input: { inspection: unknown | null | undefined }) {
  if (input.inspection) return;
  throw new StageGateBlockedError("Room inspection not complete or deferred", "INSPECTION_NOT_COMPLETE_OR_DEFERRED");
}
