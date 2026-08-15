import { CommunicationType } from "@prisma/client";
import { StateTransitionError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 52 — Communication Acknowledgement Tracking.
 *
 * Guards for CAPTURING a guest acknowledgement against an outbound governed communication —
 * the counterpart to the W22 window that times one out. Mirrors the S2 quotation acceptance
 * shape (`s2-quotation-service.acceptQuotation`), which is the only one of these that had a
 * capture path before.
 *
 * The governing rule, per the operator: **an acknowledgement is evidence of what the guest
 * actually said, so it may only be recorded against something that was actually sent.** A
 * generated-but-never-dispatched artifact has nothing for a guest to have responded to.
 * Progression gates deliberately do NOT depend on any of this — see
 * `p07-quotation-generated-for-s2-exit` for the generate-vs-send split — with one exception
 * (2026-07-31): a DISPATCHED proforma's answer gates the S3→S4 freeze, enforced by
 * `enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation` in p40 (not here — this file
 * stays capture-only).
 */

/** The outbound communications a guest can meaningfully acknowledge. */
export const ACKNOWLEDGEABLE_COMM_TYPES: readonly CommunicationType[] = [
  CommunicationType.QUOTATION,
  CommunicationType.PROFORMA_INVOICE,
  CommunicationType.CONFIRMATION_VOUCHER,
  CommunicationType.PRE_ARRIVAL_REMINDER,
  // Final bill (2026-08-17): the guest's answer — "paid", "will pay by X", a dispute — is
  // evidence next to the OUTSTANDING follow-up. Never a gate; W8 chases the money.
  CommunicationType.FINAL_INVOICE,
];

export type AcknowledgementMethod = "WRITTEN" | "VERBAL";

/** Policy 52 — only outbound guest-facing communications carry an acknowledgement loop. */
export function enforceCommunicationIsAcknowledgeable(input: {
  commType: CommunicationType;
  direction: string | null;
}) {
  if (input.direction && input.direction !== "OUTBOUND") {
    throw new StateTransitionError(
      "Only an outbound communication can carry a guest acknowledgement",
      "COMMUNICATION_NOT_OUTBOUND",
    );
  }
  if (!ACKNOWLEDGEABLE_COMM_TYPES.includes(input.commType)) {
    throw new StateTransitionError(
      `${input.commType} does not carry a guest acknowledgement loop`,
      "COMMUNICATION_TYPE_NOT_ACKNOWLEDGEABLE",
    );
  }
}

/**
 * Policy 52 — the artifact must have gone out. Acknowledgement records what the guest said in
 * response; there is no response to something never sent.
 */
export function enforceCommunicationDispatchedForAcknowledgement(input: { sendStatus: string | null }) {
  if (input.sendStatus === "DISPATCHED") return;
  throw new StateTransitionError(
    "This has not been sent to the guest yet — there is nothing for them to have accepted",
    "COMMUNICATION_NOT_DISPATCHED",
  );
}

/** Policy 52 — acknowledgement is captured once; a second capture would overwrite the evidence. */
export function enforceAcknowledgementNotAlreadyReceived(input: { acknowledgementStatus: string | null }) {
  if (input.acknowledgementStatus !== "RECEIVED") return;
  throw new StateTransitionError(
    "Acknowledgement is already recorded for this communication",
    "ACKNOWLEDGEMENT_ALREADY_RECEIVED",
  );
}

/**
 * Policy 52 — method + evidence shape, matching quotation acceptance: a VERBAL acknowledgement
 * must carry the operator's verbatim note of what the guest said, because that note IS the
 * evidence. A WRITTEN one is backed by the guest's own message.
 */
export function enforceAcknowledgementEvidence(input: { method: string; verbatimNote?: string | null }): {
  method: AcknowledgementMethod;
  verbatimNote: string | null;
} {
  if (input.method !== "WRITTEN" && input.method !== "VERBAL") {
    throw new ValidationError("acknowledgementMethod must be WRITTEN or VERBAL");
  }
  const note = input.verbatimNote?.trim() ?? "";
  if (input.method === "VERBAL" && !note) {
    throw new ValidationError("verbatimNote is required for a VERBAL acknowledgement — record what the guest said");
  }
  if (note.length > 1000) {
    throw new ValidationError("verbatimNote must be 1000 characters or fewer");
  }
  return { method: input.method, verbatimNote: note ? note : null };
}
