import { HoldState, Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** SIG-S4: entry must be at S3 before reservation confirmation. */
export function enforceEntryAtS3ForReservationConfirmation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S3) return;
  throw new StageGateBlockedError("Entry must be at S3 to confirm", "NOT_AT_S3");
}

/** SIG-S4: active segment must have an ACCEPTED quotation. */
export function enforceAcceptedQuotationPresentForS4Confirmation(input: { hasAcceptedQuotation: boolean }) {
  if (input.hasAcceptedQuotation) return;
  throw new StageGateBlockedError("Accepted quotation required", "NO_ACCEPTED_QUOTATION");
}

/** Policy 31 — provisional folio must exist before confirmation (this slice). */
export function enforceProvisionalFolioPresentForS4Confirmation(input: { folio: unknown | null | undefined }) {
  if (input.folio) return;
  throw new StageGateBlockedError("Provisional folio required", "MISSING_FOLIO");
}

/** Policy 33 — billing model fixation (latest transition) required before confirmation. */
export function enforceBillingModelFixatedForS4Confirmation(input: { billingModel: unknown | null | undefined }) {
  if (input.billingModel) return;
  throw new StageGateBlockedError("Billing model fixation required", "MISSING_BILLING_MODEL");
}

/** Policy 33 — at least one proforma invoice on folio before confirmation (slice default; waive not implemented). */
export function enforceProformaInvoicePresentForS4Confirmation(input: { hasProformaInvoice: boolean }) {
  if (input.hasProformaInvoice) return;
  throw new StageGateBlockedError("Proforma invoice required", "MISSING_PROFORMA_INVOICE");
}

/**
 * Policy 26 — committed hold present, PLACED, and has at least one room bound. Multi-room-safe:
 * accepts either the legacy `roomId` field OR the per-night `perNightBreakdown` snapshot as
 * evidence that at least one room is held. Rejecting a booking because roomId happens to be
 * NULL when the hold is per-night would be wrong — the perNightBreakdown IS the room binding.
 */
export function enforceCommittedHoldReadyForS4Confirmation(input: {
  hold:
    | {
        state: HoldState;
        roomId: string | null;
        perNightBreakdown?: unknown;
      }
    | null
    | undefined;
}) {
  if (!input.hold) throw new StageGateBlockedError("CommittedHold required before confirmation", "MISSING_COMMITTED_HOLD");
  if (input.hold.state !== HoldState.PLACED) {
    throw new StageGateBlockedError("CommittedHold must be PLACED to confirm", "HOLD_NOT_PLACED");
  }
  // Multi-room accept: either legacy roomId OR at least one room in the per-night snapshot.
  const hasRoomId = typeof input.hold.roomId === "string" && input.hold.roomId.length > 0;
  let hasPerNightRoom = false;
  const breakdown = input.hold.perNightBreakdown as
    | Array<{ roomIds?: Array<{ roomId?: string }> }>
    | null
    | undefined;
  if (Array.isArray(breakdown)) {
    for (const night of breakdown) {
      for (const r of night.roomIds ?? []) {
        if (typeof r?.roomId === "string" && r.roomId.length > 0) {
          hasPerNightRoom = true;
          break;
        }
      }
      if (hasPerNightRoom) break;
    }
  }
  if (!hasRoomId && !hasPerNightRoom) {
    throw new StageGateBlockedError("CommittedHold must have at least one room bound", "HOLD_MISSING_ROOM");
  }
}
