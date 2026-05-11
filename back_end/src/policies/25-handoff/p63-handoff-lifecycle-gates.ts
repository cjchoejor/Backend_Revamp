import { HandoffState } from "@prisma/client";
import { PolicyGateBlockedError, StageGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 63 — Handoff Lifecycle
 * Minimal gates for this backend slice: mandatory checklist items on accept, and fulfilment evidence shape.
 */

/** S7→S8: H4 must be initiated unless same-day departure auto-fulfil path applies. */
export function enforceH4InitiatedBeforeS7ToS8UnlessSameDayDeparture(input: {
  h4Valid: boolean;
  isSameDayDeparture: boolean;
}) {
  if (input.h4Valid) return;
  if (input.isSameDayDeparture) return;
  throw new StageGateBlockedError("H4 must be initiated before S7→S8", "H4_NOT_INITIATED");
}

/** S9 closure: H5 cannot remain in CREATED/ACCEPTED unless auto-fulfilled. */
export function enforceH5NotBlockingS9Closure(input: {
  h5: { state: HandoffState | string; isAutoFulfilled?: boolean | null } | null | undefined;
}) {
  if (!input.h5 || input.h5.isAutoFulfilled) return;
  const s = String(input.h5.state);
  if (s === HandoffState.CREATED || s === HandoffState.ACCEPTED) {
    throw new StageGateBlockedError("H5 must be fulfilled/closed before entry closure", "H5_NOT_FULFILLED");
  }
}

/** S8→S9: H4 must exist and be fulfilled (or auto-fulfilled). */
export function enforceH4FulfilledOrAutoBeforeS8Exit(input: {
  h4: { state: HandoffState | string; isAutoFulfilled?: boolean | null } | null | undefined;
}) {
  if (!input.h4) {
    throw new StageGateBlockedError("H4 is required at checkout", "H4_NOT_PRESENT");
  }
  if (input.h4.isAutoFulfilled) return;
  if (input.h4.state === HandoffState.FULFILLED) return;
  throw new StageGateBlockedError("H4 must be fulfilled before S8 exit", "H4_NOT_FULFILLED");
}

/** S8→S9: H5 record must exist after checkout handoff build. */
export function enforceH5PresentForS8ToS9(input: { h5: unknown | null | undefined }) {
  if (input.h5) return;
  throw new StageGateBlockedError("H5 not created", "H5_NOT_CREATED");
}

/** S6 check-in completion: H2/H3 in REJECTED require FOM rerouting before exit. */
export function enforceH2H3NotRejectedAtS6CheckIn(input: {
  h2State: HandoffState | null | undefined;
  h3State: HandoffState | null | undefined;
}) {
  if (input.h2State === HandoffState.REJECTED || input.h3State === HandoffState.REJECTED) {
    throw new StageGateBlockedError("H2 or H3 is in REJECTED state — FOM rerouting required", "HANDOFF_REJECTED");
  }
}

export function enforceMandatoryChecklistItemsCompleted(input: {
  handoffType: string;
  mandatoryItemCodes: string[];
  checklistCompletion: Record<string, boolean> | undefined;
}) {
  const completion = input.checklistCompletion;
  if (!completion || typeof completion !== "object") {
    throw new ValidationError("checklistCompletion object is required");
  }

  for (const code of input.mandatoryItemCodes) {
    if (!completion[code]) {
      throw new PolicyGateBlockedError(
        `${input.handoffType}_CHECKLIST_INCOMPLETE`,
        `Mandatory checklist item not completed: ${code}`,
      );
    }
  }
}

export function enforceHandoffFulfilmentEvidence(input: {
  handoffType: "H1" | "H4" | "H5";
  fulfilmentEvidence: Record<string, unknown> | undefined;
}) {
  const ev = input.fulfilmentEvidence ?? {};
  const requiredKeys =
    input.handoffType === "H4"
      ? ["chargesPostedConfirmation", "roomInspectionStatus", "damageAssessmentStatus", "deficientFlagFinalStatus"]
      : input.handoffType === "H5"
        ? ["resolutionBasis"]
        : ["roomAssignmentId", "readinessConfirmed", "paymentStatusConfirmed", "ceilingProximityAddressed"];

  for (const key of requiredKeys) {
    if (ev[key] === undefined || ev[key] === null) {
      throw new PolicyGateBlockedError(
        input.handoffType === "H4"
          ? "H4_FULFILMENT_EVIDENCE_INCOMPLETE"
          : input.handoffType === "H5"
            ? "H5_FULFILMENT_EVIDENCE_INCOMPLETE"
            : "FULFILMENT_EVIDENCE_INCOMPLETE",
        `fulfilmentEvidence.${key} is required`,
      );
    }
  }

  if (input.handoffType === "H1" && ev.readinessConfirmed !== true) {
    throw new PolicyGateBlockedError("ROOM_NOT_READY", "readinessConfirmed must be true when room is ready");
  }

  return ev;
}

