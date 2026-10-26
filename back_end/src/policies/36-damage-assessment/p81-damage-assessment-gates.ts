import { StageGateBlockedError } from "../../lib/errors.js";
import { roomListWords } from "../../lib/room-inspection-standing.js";

/**
 * Policy 81 — a damage found at a room inspection is answered before the money closes
 * (2026-10-26, operator: "I marked room 304 as damaged, yet nothing appeared on S9 while sealing
 * and closing it — nothing to waive or ask for payment for the damage").
 *
 * SIG-S8 §253 lists "damage assessment complete or governed-deferred" among the S8→S9 conditions.
 * The operator ruled the bill waits too: a guest must not be settled and sent off with a damage
 * still unpriced. The answers (lib/damage-standing.ts): charge it, waive it (the FOM's), or decide
 * after departure — which lets the booking leave Check-out, but not be sealed.
 */


/** Settlement — every damage found has an answer. */
export function enforceDamageAnsweredBeforeSettlement(input: { unansweredRooms: string[] }) {
  if (!input.unansweredRooms.length) return;
  throw new StageGateBlockedError(
    `The damage found in ${roomListWords(input.unansweredRooms)} needs an answer before the bill is settled — charge it, waive it, or decide it after departure`,
    "DAMAGE_NOT_ANSWERED",
  );
}

/** The move to Closed — every damage found has an answer (deciding it after departure is one). */
export function damageNotAnsweredForS8Exit(input: { unansweredRooms: string[] }) {
  if (!input.unansweredRooms.length) return null;
  return {
    blockingCondition: "DAMAGE_NOT_ANSWERED",
    message: `The damage found in ${roomListWords(input.unansweredRooms)} needs an answer — charge it, waive it, or decide it after departure`,
  };
}

/** Sealing — every damage found is charged or waived. */
export function enforceDamageDecidedForS9Closure(input: { undecidedRooms: string[] }) {
  if (!input.undecidedRooms.length) return;
  throw new StageGateBlockedError(
    `The damage found in ${roomListWords(input.undecidedRooms)} is still to be charged or waived`,
    "DAMAGE_NOT_DECIDED",
  );
}
