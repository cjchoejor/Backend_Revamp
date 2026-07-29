import { HoldState, InvoiceState, Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** SIG-S4: entry must be at S3 before reservation confirmation. */
export function enforceEntryAtS3ForReservationConfirmation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S3) return;
  throw new StageGateBlockedError("Entry must be at S3 to confirm", "NOT_AT_S3");
}

/** SIG-S4: active segment must have an ACCEPTED quotation. Spec-strict form — see below. */
export function enforceAcceptedQuotationPresentForS4Confirmation(input: { hasAcceptedQuotation: boolean }) {
  if (input.hasAcceptedQuotation) return;
  throw new StageGateBlockedError("Accepted quotation required", "NO_ACCEPTED_QUOTATION");
}

/**
 * SIG-S4: active segment must have a quotation to freeze terms from.
 *
 * Relaxed from the ACCEPTED-only form above per the operator's generate-vs-send ruling
 * (2026-07-28) — see `p07-quotation-generated-for-s2-exit` for the reasoning. Relaxing S2→S3
 * alone would have been pointless: the booking would clear S2 and then jam at the freeze.
 *
 * The commercial basis is still whichever quotation `resolveOperativeQuotation` picks, which
 * prefers ACCEPTED whenever one exists — so a booking the guest did accept freezes exactly the
 * terms it always did. Only the never-sent case behaves differently, and there the alternative
 * was being unable to confirm at all.
 */
export function enforceQuotationPresentForS4Confirmation(input: { hasQuotation: boolean }) {
  if (input.hasQuotation) return;
  throw new StageGateBlockedError(
    "A quotation must be generated for this segment before confirmation",
    "NO_QUOTATION_GENERATED",
  );
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
 * Policy 33 (2026-07-28) — once a guest has actually PAID an advance, the proforma invoice
 * must have been DISPATCHED to them before the reservation can be confirmed.
 *
 * Business rule: money changing hands has to be documented to the guest. The moment any
 * advance payment lands on the folio, a merely DRAFT proforma is not enough — the guest is
 * owed the invoice their payment sits against.
 *
 * The trigger is the amount RECEIVED, deliberately not the configured requirement. Those come
 * apart in practice: `advancePayment.thresholds` may be 0 for a booking shape (no deposit
 * demanded) and the guest still chooses to pay something up front. That voluntary payment
 * needs documenting exactly as much as a demanded one does.
 *
 * A proforma counts as dispatched once `dispatchedAt` is set or its state has moved past
 * DRAFT. SUPERSEDED proformas are ignored: a replaced invoice is not the live one, so a
 * booking whose only dispatched proforma was later superseded must dispatch the replacement.
 */
export function enforceProformaDispatchedWhenAdvancePaid(input: {
  proformaInvoices: Array<{ state: InvoiceState; dispatchedAt: Date | null }>;
  totalAdvanceReceived: number;
}) {
  if (!(input.totalAdvanceReceived > 0)) return; // nothing paid yet → dispatch optional
  const live = input.proformaInvoices.filter((i) => i.state !== InvoiceState.SUPERSEDED);
  const dispatched = live.some((i) => i.dispatchedAt != null || i.state !== InvoiceState.DRAFT);
  if (dispatched) return;
  throw new StageGateBlockedError(
    `An advance payment of ${input.totalAdvanceReceived.toFixed(2)} has been received — dispatch the proforma invoice to the guest before confirming.`,
    "PROFORMA_INVOICE_NOT_DISPATCHED",
  );
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
