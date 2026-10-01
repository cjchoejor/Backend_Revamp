import type { ActorLevel } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { PolicyGateBlockedError, StageGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S5→S6 progression requires entry at S5. */
export function enforceEntryAtS5ForS5ToS6Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StageGateBlockedError("Entry is not at S5", "NOT_AT_S5");
}

/** Policy 1 — S6→S1 re-entry (room change) requires entry at S6. */
export function enforceEntryAtS6ForS6ToS1ReEntry(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S6) return;
  throw new StageGateBlockedError("Entry must be at S6 for re-entry", "NOT_AT_S6");
}

/** Policy 1 — check-in completion (S6→S7) requires entry at S6. */
export function enforceEntryAtS6ForCheckInCompletionToS7(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S6) return;
  throw new StageGateBlockedError("Entry must be at S6 to complete check-in", "NOT_AT_S6");
}

/** Policy 1 — S7→S8 progression requires entry at S7. */
export function enforceEntryAtS7ForS7ToS8Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StageGateBlockedError("Entry is not at S7", "NOT_AT_S7");
}

/**
 * Policy 1 / Policy 35 — cancelling a CONFIRMED booking before arrival: at Reserve (S4) or at
 * Arrival (S5) (`CancellationService.cancelEntryAtS5`, 2026-09-18).
 *
 * The route was S5-only, and a booking reaches S5 only a day before arrival
 * (`preArrival.windowDays`), so every confirmed booking further out — the ordinary "we can't come
 * next month" call — had no way to be cancelled at all. SIG-S4 has Policy 35 active at S4 and
 * forbids releasing confirmed inventory without a governed cancellation; this is that cancellation,
 * priced on the terms frozen at confirmation exactly as at Arrival.
 */
export function enforceEntryConfirmedForPreArrivalCancellation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S4 || input.currentStage === Stage.S5) return;
  throw new StageGateBlockedError(
    "A confirmed booking is cancelled at Reserve or at Arrival — this one is at neither",
    "NOT_AT_S4_OR_S5",
  );
}

/** Policy 1 — S5-only cancellation route (`CancellationService.cancelEntryAtS5`). */
export function enforceEntryAtS5ForS5CancellationRoute(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StageGateBlockedError(
    "Cancellation at this route is only supported for entries at S5",
    "NOT_AT_S5",
  );
}

/** Policy 1 — SIG-S3 §6.5 — pre-confirmation cancellation while at S3 (`CancellationService.cancelEntryAtS3`). */
export function enforceEntryAtS3ForS3CancellationRoute(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S3) return;
  throw new StageGateBlockedError(
    "S3 cancellation is only supported for entries currently at S3",
    "NOT_AT_S3",
  );
}

/**
 * Policy 1 — the desk ending a lead the guest turned down, before anything is committed
 * (2026-10-01, operator request for "the guest said no" at Inquiry and Negotiation).
 *
 * Only Inquiry and Negotiation. From Set up onward a booking carries a folio, a disclosed
 * cancellation term and usually money, and ending it is the priced act the cancel routes
 * perform — not this one.
 */
export function enforceEntryBeforeSetupForDecline(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1 || input.currentStage === Stage.S2) return;
  throw new StageGateBlockedError(
    "A booking is turned down from Inquiry or Negotiation. Past Set up it is cancelled through the cancellation route, which prices the terms and handles any money taken.",
    "NOT_BEFORE_SETUP",
  );
}

/** Policy 1 — SIG-S6 Policy 35 — post-check-in early departure (`CancellationService.cancelEntryEarlyDepartureAfterCheckIn`). */
export function enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StageGateBlockedError(
    "Early departure cancellation is only supported for checked-in entries at S7",
    "NOT_AT_S7",
  );
}

/** Policy 1 — no-show determination flow requires entry at S5. */
export function enforceEntryAtS5ForNoShowActions(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StateTransitionError("No-show actions are only valid at S5");
}

/** Policy 1 — H4 initiation requires entry at S7. */
export function enforceEntryAtS7ForH4Initiation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StateTransitionError("Entry must be at S7 to initiate H4", "NOT_AT_S7");
}

/** Policy 1 — H4 initiation requires ACTIVE entry. */
export function enforceEntryActiveForH4Initiation(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.ACTIVE) return;
  throw new StateTransitionError("Entry must be ACTIVE to initiate H4");
}

/** Policy 1 — createH2 requires active entry at S6. */
export function enforceEntryAtS6AndActiveForCreateH2(input: { currentStage: Stage; status: EntryStatus }) {
  if (input.currentStage === Stage.S6 && input.status === EntryStatus.ACTIVE) return;
  throw new StateTransitionError("createH2 is only available for active entries at S6");
}

/** Policy 1 — S7 room-change re-entry (application slice) requires entry at S7. */
export function enforceEntryAtS7ForRoomChangeReEntry(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StateTransitionError("Room change re-entry is only supported from S7", "NOT_AT_S7");
}

/** Policy 1 — generic progressive stage route must not operate on CLOSED entries. */
export function enforceEntryNotClosedForStageProgression(input: { status: EntryStatus }) {
  if (input.status !== EntryStatus.CLOSED) return;
  throw new StateTransitionError("Cannot progress stage for CLOSED entry", "ENTRY_ALREADY_CLOSED");
}

/**
 * Policy 1 — every stage transition originates from `(ACTIVE, Sn)`.
 *
 * DEV-SPEC-001 Part 3 §3.2.2/§3.2.8 and the transition table in every SIG list `(ACTIVE, Sn)` as
 * the source state for forward progressions, backflows and re-entries alike; `(PARKED, Sn)` has
 * exactly one legal outgoing transition — unpark.
 *
 * Without this guard a PARKED entry could be progressed straight through: S1→S2 would then cancel
 * the park-expiry timer and open the next stage's dwell record in ACTIVE mode while `status` stayed
 * PARKED, leaving a booking that is nominally paused, has no expiry clock, and shows the wrong
 * dwell band. The park was silently defeated.
 */
export function enforceEntryActiveForStageTransition(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.ACTIVE) return;
  if (input.status === EntryStatus.PARKED) {
    throw new StateTransitionError(
      "Entry is PARKED — resume it before progressing the stage",
      "ENTRY_PARKED",
    );
  }
  throw new StateTransitionError(
    `Cannot progress a ${input.status} entry`,
    "ENTRY_NOT_ACTIVE",
  );
}

/**
 * Sealed records are read-only (2026-07-31). EXPIRED / CANCELLED / CLOSED are terminal — the
 * desk shows those bookings as history, and the API must refuse working writes against them
 * too, or any frontend can keep shaping a booking that operationally no longer exists (the
 * reported case: an availability search + room selection saved onto an EXPIRED entry).
 *
 * PARKED is deliberately allowed through: a park is a pause, not a seal — exploring
 * availability while parked is legitimate, and progression is separately gated by
 * `enforceEntryActiveForStageTransition`.
 */
/**
 * The rooms and the party may be changed at NEGOTIATION, in place (2026-09-30, operator ruling).
 *
 * S2 only, and deliberately so. At S1 the intake edit is already the way. At S3 a committed hold
 * and possibly money stand; at S4 a frozen Reservation does — both of which the existing
 * re-entry to Negotiation deals with properly by sealing the pass and superseding the paperwork,
 * after which the operator amends here and walks forward again. Giving those stages their own
 * in-place form would be a second, weaker door into the same act.
 */
export function enforceEntryAtS2ForNegotiationAmendment(input: { currentStage: Stage; status: EntryStatus }) {
  enforceEntryNotSealedForWorkingAction({ status: input.status });
  if (input.status === EntryStatus.PARKED) {
    throw new StateTransitionError(
      "This booking is parked — resume it before changing the rooms or the party",
      "ENTRY_PARKED",
    );
  }
  if (input.currentStage !== Stage.S2) {
    throw new StateTransitionError(
      input.currentStage === Stage.S1
        ? "The booking is still at Inquiry — change the rooms and the party there"
        : `The rooms and the party are changed at Negotiation — this booking is at ${input.currentStage}. Re-enter to Negotiation first, then change it there.`,
      "NOT_AT_S2",
    );
  }
}

/**
 * Authority follows what MOVED, not the stage — the p58 doctrine, applied to the paper the guest
 * is holding rather than to the step the booking sits on.
 *
 *   nothing sent   → L1. The same act as picking the rooms in the first place, one call later.
 *   quote SENT     → L2. The guest holds a quotation this makes untrue.
 *   quote ACCEPTED → L2. They agreed to these rooms at this price; changing it is not a desk
 *                    decision, it is flagged up to the FOM or the GM (operator, 2026-09-30).
 *
 * An accepted quote is NOT refused outright: the operator's ruling was that the change must be
 * possible, with approval — so an FOM or a GM applies it directly, and an L1 is told whose call
 * it is instead of being sent back to Inquiry.
 */
export function enforceNegotiationAmendmentAuthority(input: {
  actorLevel: ActorLevel;
  quotationSent: boolean;
  quotationAccepted: boolean;
}) {
  const elevated = input.actorLevel === "L2" || input.actorLevel === "L3" || input.actorLevel === "L4";
  if (elevated) return;
  if (input.quotationAccepted) {
    throw new PolicyGateBlockedError(
      "AUTH_REQUIRED_L2",
      "The guest has ACCEPTED this quotation — changing the rooms or the party now needs the FOM's approval.",
    );
  }
  if (input.quotationSent) {
    throw new PolicyGateBlockedError(
      "AUTH_REQUIRED_L2",
      "The quotation has gone to the guest — changing the rooms or the party now needs the FOM.",
    );
  }
}

export function enforceEntryNotSealedForWorkingAction(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.ACTIVE || input.status === EntryStatus.PARKED) return;
  // In words, not the enum: this refusal reaches the desk (2026-10-01).
  const what =
    input.status === EntryStatus.EXPIRED
      ? "has lapsed"
      : input.status === EntryStatus.CANCELLED
        ? "was ended"
        : "is closed";
  throw new StateTransitionError(
    `This booking ${what} — a sealed record is read-only`,
    "ENTRY_SEALED_READ_ONLY",
  );
}

/**
 * The desk may set this booking's own hold time from Inquiry to Set up (2026-09-25).
 *
 * Before Set up there is no hold yet, but the guest's "I'll confirm by six" is already known and
 * the booking remembers it for the placement to come. From Reserve onward the rooms are confirmed
 * and the hold's clock no longer holds them, so changing it would say nothing.
 */
export function enforceEntryStageForHoldExpiryChange(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1 || input.currentStage === Stage.S2 || input.currentStage === Stage.S3) return;
  throw new StateTransitionError(
    "The hold time is set before the booking is reserved — from Reserve onward the rooms are held by the reservation itself",
    "HOLD_EXPIRY_STAGE",
  );
}

/** Policy 1 — S2→S3 progression requires entry at S2 (StateTransitionError matches prior service). */
export function enforceEntryAtS2ForS2ToS3Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S2) return;
  throw new StateTransitionError("Entry is not at S2");
}
