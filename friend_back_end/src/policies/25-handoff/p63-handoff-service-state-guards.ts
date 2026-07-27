import { HandoffState, HandoffType } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

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
  }
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
