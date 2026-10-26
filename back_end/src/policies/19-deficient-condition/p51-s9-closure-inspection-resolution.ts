import { StageGateBlockedError } from "../../lib/errors.js";

type RoomState = "NOT_RECORDED" | "DONE" | "PUT_OFF" | "LAPSED";

function roomWords(numbers: string[]): string {
  if (numbers.length === 1) return `Room ${numbers[0]}`;
  return `Rooms ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/**
 * Policy 51 — DEFICIENT / inspection review (SIG-S9 closure slice).
 *
 * Every room the guest left at check-out is inspected, or its put-off window closed (SIG-S9 §334 /
 * AC-S9-020, "completed OR lapsed") — one inspection per room since 2026-10-26.
 */
export function enforceInspectionResolvedForS9Closure(input: { rooms: Array<{ roomNumber: string; state: RoomState }> }) {
  if (input.rooms.length === 0) {
    throw new StageGateBlockedError("Missing room inspection record", "INSPECTION_MISSING");
  }
  const missing = input.rooms.filter((r) => r.state === "NOT_RECORDED").map((r) => r.roomNumber);
  if (missing.length) {
    throw new StageGateBlockedError(`${roomWords(missing)} not inspected`, "INSPECTION_MISSING");
  }
  const open = input.rooms.filter((r) => r.state === "PUT_OFF").map((r) => r.roomNumber);
  if (open.length) {
    throw new StageGateBlockedError(
      `${roomWords(open)}: the inspection put off at check-out is still open — record it, or close its window`,
      "INSPECTION_DEFERRED_UNRESOLVED",
    );
  }
}
