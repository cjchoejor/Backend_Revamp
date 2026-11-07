import { paperNumber, printedProformaNumber, printedQuotationNumber, proformaNumberOf } from "../../lib/document-numbers.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import type { PrismaClient } from "@prisma/client";
import { resolveSendTo } from "../../lib/send-to.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { resendConfirmationVoucher } from "./s4-confirmation-service.js";
import { armVoucherReplyWindow } from "./communication-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { dispatchInvoice } from "./s9-service.js";

/**
 * Answering a HELD PAPER (2026-10-12, operator ruling: "no paper goes to a guest unless the desk
 * chooses"). A room-change walk generates the paper and holds it (lib/held-documents.ts); the desk
 * answers here, once:
 *
 *   - EMAIL     — sent through the paper's own route: the voucher by `resendConfirmationVoucher`
 *                 (a fresh communication and answer window, the PDF attached), the proforma by
 *                 `dispatchInvoice` (dispatched to whom it is made out to — `resolveInvoiceRecipient`);
 *   - WHATSAPP  — the desk shared it on WhatsApp; recorded, nothing is emailed. A VOUCHER only: a
 *                 bill is dispatched by email (the Set up gates read a dispatched proforma, and a
 *                 WhatsApp mark would leave them shut while reading as sent);
 *   - NONE      — not sent, and why when the desk says.
 *
 * Every answer is recorded on the row and traced (`DOCUMENT.SENT` / `DOCUMENT.NOT_SENT`).
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

export type HeldDocumentView = {
  id: string;
  entryId: string;
  kind: "CONFIRMATION_VOUCHER" | "PROFORMA";
  documentId: string;
  /** The number printed on the paper — the voucher's VOU-… (2026-10-13), the bill's INV-…. */
  documentNumber: string;
  reason: string;
  roomMoveLegId: string | null;
  heldAt: string;
  heldBy: string;
  decision: string | null;
  sentTo: string | null;
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /**
   * Where the paper would go by default (lib/send-to.ts, 2026-11-07): through an agency or a company,
   * the booking's contact person there, else the party itself; on a direct booking the guest. `to`
   * is the email, `phone` the number a WhatsApp send starts with.
   */
  defaultRecipient: { to: string | null; whose: string | null; phone: string | null; phoneWhose: string | null };
};

async function defaultRecipientFor(prisma: PrismaClient, row: { entryId: string; kind: string }): Promise<HeldDocumentView["defaultRecipient"]> {
  const sendTo = await resolveSendTo(prisma, row.entryId);
  return { to: sendTo.email, whose: sendTo.emailWhose, phone: sendTo.phone, phoneWhose: sendTo.phoneWhose };
}

function view(row: {
  id: string;
  entryId: string;
  kind: string;
  documentId: string;
  reason: string;
  roomMoveLegId: string | null;
  heldAt: Date;
  heldBy: string;
  decision: string | null;
  sentTo: string | null;
  note: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
}, defaultRecipient: HeldDocumentView["defaultRecipient"], documentNumber?: string | null): HeldDocumentView {
  return {
    id: row.id,
    entryId: row.entryId,
    kind: row.kind as HeldDocumentView["kind"],
    documentId: row.documentId,
    documentNumber: documentNumber || row.documentId,
    reason: row.reason,
    roomMoveLegId: row.roomMoveLegId,
    heldAt: row.heldAt.toISOString(),
    heldBy: row.heldBy,
    decision: row.decision,
    sentTo: row.sentTo,
    note: row.note,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    defaultRecipient,
  };
}

/** The booking's held papers, newest first — the undecided ones are what the desk still has to answer. */
export async function listHeldDocuments(prisma: PrismaClient, entryId: string): Promise<HeldDocumentView[]> {
  const rows = await prisma.heldDocument.findMany({ where: { entryId }, orderBy: { heldAt: "desc" } });
  const voucherNos = await voucherNumbersFor(prisma, rows);
  const out: HeldDocumentView[] = [];
  for (const r of rows) {
    out.push(view(r, r.decision == null ? await defaultRecipientFor(prisma, r) : { to: null, whose: null, phone: null, phoneWhose: null }, voucherNos.get(r.documentId)));
  }
  return out;
}

/** A voucher row names its reservation; the paper carries the voucher's own number. */
async function voucherNumbersFor(prisma: PrismaClient, rows: { kind: string; documentId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = rows.filter((r) => r.kind === "CONFIRMATION_VOUCHER").map((r) => r.documentId);
  if (ids.length) {
    const res = await prisma.reservation.findMany({ where: { id: { in: ids } }, select: { id: true, confirmationVoucherNumber: true } });
    for (const r of res) if (r.confirmationVoucherNumber) out.set(r.id, r.confirmationVoucherNumber);
  }
  // A proforma's number with its version (2026-11-07): a later version's record id is `INV-…-v2`.
  const pf = rows.filter((r) => r.kind === "PROFORMA").map((r) => r.documentId);
  if (pf.length) {
    const inv = await prisma.invoice.findMany({ where: { id: { in: pf } }, select: { id: true, documentNumber: true, invoiceNumber: true, versionNumber: true } });
    for (const i of inv) out.set(i.id, printedProformaNumber(i));
  }
  return out;
}

export async function decideHeldDocument(
  prisma: PrismaClient,
  heldDocumentId: string,
  actor: Actor,
  input: { action: "EMAIL" | "WHATSAPP" | "NONE"; sentTo?: string | null; note?: string | null; nightsEach?: boolean },
): Promise<HeldDocumentView> {
  const row = await prisma.heldDocument.findUnique({ where: { id: heldDocumentId } });
  if (!row) throw new NotFoundError("Held document");
  if (row.decision) {
    throw new ValidationError(
      row.decision === "SUPERSEDED"
        ? "A newer paper replaced this one — answer that one instead"
        : "This paper was already answered — send it again from the booking's Documents tab",
    );
  }
  const note = input.note?.trim() || null;
  let sentTo: string | null = null;

  if (input.action === "EMAIL") {
    if (row.kind === "CONFIRMATION_VOUCHER") {
      const out = (await resendConfirmationVoucher(prisma, row.documentId, actor.actorId, {
        dispatchedTo: input.sentTo?.trim() || null,
        nightsEach: input.nightsEach === true,
      })) as { dispatchedTo?: string | null; recipient?: string | null };
      sentTo = out?.dispatchedTo ?? out?.recipient ?? input.sentTo?.trim() ?? null;
    } else {
      const inv = await dispatchInvoice(prisma, row.documentId, actor.actorId, {
        ...(input.sentTo?.trim() ? { dispatchedTo: input.sentTo.trim() } : {}),
        nightsEach: input.nightsEach === true,
      });
      sentTo = (inv as { dispatchedTo?: string | null }).dispatchedTo ?? input.sentTo?.trim() ?? null;
    }
  } else if (input.action === "WHATSAPP") {
    if (row.kind === "PROFORMA") {
      throw new ValidationError("A bill is sent by email — WhatsApp is not recorded for a bill. Send it by email, or don't send it.");
    }
    sentTo = cleanPhone(input.sentTo, "The number it went to");
    // It has gone out now, so the guest's answer is awaited from now (a held voucher's clock
    // does not run while it waits for the desk).
    const windows = await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType").catch(() => null);
    await armVoucherReplyWindow(prisma, {
      reservationId: row.documentId,
      actorId: actor.actorId,
      voucherAckSeconds: Number((windows as Record<string, number> | null)?.voucher ?? 172800),
    });
  }

  const decision = input.action === "EMAIL" ? "SENT_EMAIL" : input.action === "WHATSAPP" ? "SENT_WHATSAPP" : "NOT_SENT";
  const now = new Date();
  // A voucher not sent awaits no answer (2026-10-29, operator: "sending the confirmation voucher
  // is not mandatory, but if sent, the reply is").
  if (decision === "NOT_SENT" && row.kind === "CONFIRMATION_VOUCHER") {
    await prisma.communicationRecord.updateMany({
      where: {
        entryId: row.entryId,
        commType: "CONFIRMATION_VOUCHER",
        sendStatus: "HELD",
        payload: { path: ["reservationId"], equals: row.documentId },
      },
      data: { sendStatus: "NOT_SENT", contentSummary: "Confirmation voucher not sent to the guest" },
    });
  }
  const updated = await prisma.heldDocument.update({
    where: { id: row.id },
    data: { decision, sentTo, note, decidedAt: now, decidedBy: actor.actorId },
  });
  await prisma.traceEvent
    .create({
      data: {
        eventType: decision === "NOT_SENT" ? "DOCUMENT.NOT_SENT" : "DOCUMENT.SENT",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "HeldDocument",
        entityId: row.id,
        operation: "UPDATE",
        timestamp: now,
        entryId: row.entryId,
        payload: {
          heldDocumentId: row.id,
          kind: row.kind,
          documentId: row.documentId,
          reason: row.reason,
          channel: decision === "SENT_EMAIL" ? "EMAIL" : decision === "SENT_WHATSAPP" ? "WHATSAPP" : null,
          sentTo,
          note,
        },
        createdBy: actor.actorId,
      },
    })
    .catch(() => {});
  return view(updated, { to: null, whose: null, phone: null, phoneWhose: null }, (await voucherNumbersFor(prisma, [updated])).get(updated.documentId));
}
