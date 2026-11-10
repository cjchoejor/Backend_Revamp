import { HandoffState, HandoffType } from "@prisma/client";
import { PolicyGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 63 — Handoff lifecycle: accept / fulfil / reject state-machine guards
 * (StateTransitionError envelope preserved for API compatibility).
 */

export function enforceHandoffAcceptTypeSupported(configKey: string | null): asserts configKey is string {
  if (configKey) return;
  throw new StateTransitionError("Unsupported handoff type for accept");
}

export function enforceHandoffInCreatedStateForAccept(input: { handoffType: HandoffType; state: HandoffState }) {
  if (input.handoffType === HandoffType.H1) {
    if (input.state !== HandoffState.CREATED) {
      throw new StateTransitionError(`H1 must be in CREATED state to accept (current: ${input.state})`);
    }
    return;
  }
  if (input.handoffType === HandoffType.H2 || input.handoffType === HandoffType.H3) {
    if (input.state !== HandoffState.CREATED) {
      throw new StateTransitionError(`Handoff must be in CREATED state to accept (current: ${input.state})`);
    }
    return;
  }
  // H4 (2026-11-10): accepted when told, or late once its window passed (ESCALATED) — the move to
  // Check-out waits for an accepted one. Never from FULFILLED: that would undo the departure handoff.
  if (input.handoffType === HandoffType.H4) {
    if (input.state !== HandoffState.CREATED && input.state !== HandoffState.ESCALATED) {
      throw new StateTransitionError(
        `The handoff before check-out can be accepted only while it waits for it (now: ${input.state.toLowerCase()})`,
        "H4_NOT_WAITING_FOR_ACCEPTANCE",
      );
    }
  }
}

/**
 * H4 is finished at Check-out, from the room inspection (2026-11-10, operator: "yes do it"). At Stay
 * the desk tells the departments and accepts it; marking it done there recorded, on the desk's word,
 * that every room was inspected and any damage assessed before any inspection had happened, and
 * left Check-out's departure handoff reading as done. A same-day departure's handoff is written by
 * the move itself (`createH4` / the S7→S8 transition), not through here.
 */
export function enforceH4FulfilledAtCheckout(input: { handoffType: HandoffType; currentStage: string | null | undefined }) {
  if (input.handoffType !== HandoffType.H4) return;
  if (input.currentStage === "S8") return;
  throw new StateTransitionError(
    "The departure handoff is finished at Check-out, from the room inspection. At Stay, tell the departments the guest is leaving and accept it.",
    "H4_FULFIL_AT_CHECKOUT_ONLY",
  );
}

export function enforceHandoffFulfilTypeSupported(
  handoffType: HandoffType,
): asserts handoffType is "H1" | "H4" | "H5" {
  if (handoffType === HandoffType.H1 || handoffType === HandoffType.H4 || handoffType === HandoffType.H5) return;
  throw new StateTransitionError("fulfil() is only implemented for H1, H4, and H5 in this slice");
}

export function enforceHandoffFulfilStateH1(input: { handoffType: HandoffType; state: HandoffState }) {
  if (input.handoffType !== HandoffType.H1) return;
  if (input.state === HandoffState.CREATED) {
    throw new StateTransitionError("H1 cannot move to FULFILLED from CREATED — accept first");
  }
  if (input.state !== HandoffState.ACCEPTED) {
    throw new StateTransitionError(`H1 must be in ACCEPTED state to fulfil (current: ${input.state})`);
  }
}

export function enforceHandoffFulfilStateH4(input: { handoffType: HandoffType; state: HandoffState }) {
  if (input.handoffType !== HandoffType.H4) return;
  if (input.state === HandoffState.REJECTED || input.state === HandoffState.CLOSED) {
    throw new StateTransitionError(`H4 cannot be fulfilled from state ${input.state}`);
  }
}

export function enforceHandoffFulfilStateH5(input: { handoffType: HandoffType; state: HandoffState }) {
  if (input.handoffType !== HandoffType.H5) return;
  if (input.state === HandoffState.REJECTED || input.state === HandoffState.CLOSED) {
    throw new StateTransitionError(`H5 cannot be fulfilled from state ${input.state}`);
  }
}

/**
 * The after-stay handoff is done only when no bill is left to settle (2026-11-10, operator: "it
 * shouldn't even be clickable if the bill is still outstanding, or wasn't written off by higher
 * authority"). It is raised at check-out because money was still owed; marking it done while some
 * is owed would close the follow-up on money nobody collected. `owed` is the folio's balance when
 * above zero, null otherwise — a write-off brings it to zero.
 */
export function enforceH5NothingLeftToSettle(input: { handoffType: HandoffType; owed: string | null }) {
  if (input.handoffType !== HandoffType.H5) return;
  if (input.owed == null) return;
  throw new PolicyGateBlockedError(
    "H5_MONEY_STILL_OWED",
    `Nu ${input.owed} is still owed on this booking — record the payment, or the GM writes it off, then mark the after-stay handoff done.`,
  );
}

export function enforceHandoffRejectTypeSupported(input: { handoffType: HandoffType }) {
  if (input.handoffType === HandoffType.H2 || input.handoffType === HandoffType.H3) return;
  throw new StateTransitionError("reject() is only implemented for H2 and H3 in this slice");
}

export function enforceHandoffRejectableState(input: { state: HandoffState }) {
  if (input.state !== HandoffState.REJECTED && input.state !== HandoffState.CLOSED) return;
  throw new StateTransitionError(`Cannot reject handoff in state ${input.state}`);
}

export function enforceHandoffConfigKeyPresentForH4(configKey: string | null): asserts configKey is string {
  if (configKey) return;
  throw new StateTransitionError("Unsupported handoff type for createH4");
}
