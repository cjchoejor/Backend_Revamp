import type { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { resendConfirmationVoucher } from "./s4-confirmation-service.js";
import { dispatchInvoice, resolveInvoiceRecipient } from "./s9-service.js";

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
  reason: string;
  roomMoveLegId: string | null;
  heldAt: string;
  heldBy: string;
  decision: string | null;
  sentTo: string | null;
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Where an email would go by default — the guest for a voucher, whom the bill is made out to for a proforma. */
  defaultRecipient: { to: string | null; whose: string | null };
};

async function defaultRecipientFor(prisma: PrismaClient, row: { entryId: string; kind: string }) {
  if (row.kind === "PROFORMA") {
    const r = await resolveInvoiceRecipient(prisma, row.entryId).catch(() => null);
    return { to: r?.to ?? null, whose: r?.to ? r.greetName : null };
  }
  const entry = await prisma.entry.findUnique({
    where: { id: row.entryId },
    select: { guestProfile: { select: { email: true, firstName: true, lastName: true } } },
  });
  const name = [entry?.guestProfile?.firstName, entry?.guestProfile?.lastName].filter(Boolean).join(" ").trim();
  return { to: entry?.guestProfile?.email ?? null, whose: entry?.guestProfile?.email ? (name ? `${name} (the guest)` : "the guest") : null };
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
}, defaultRecipient: HeldDocumentView["defaultRecipient"]): HeldDocumentView {
  return {
    id: row.id,
    entryId: row.entryId,
    kind: row.kind as HeldDocumentView["kind"],
    documentId: row.documentId,
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
  const out: HeldDocumentView[] = [];
  for (const r of rows) out.push(view(r, r.decision == null ? await defaultRecipientFor(prisma, r) : { to: null, whose: null }));
  return out;
}

export async function decideHeldDocument(
  prisma: PrismaClient,
  heldDocumentId: string,
  actor: Actor,
  input: { action: "EMAIL" | "WHATSAPP" | "NONE"; sentTo?: string | null; note?: string | null },
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
      })) as { dispatchedTo?: string | null; recipient?: string | null };
      sentTo = out?.dispatchedTo ?? out?.recipient ?? input.sentTo?.trim() ?? null;
    } else {
      const inv = await dispatchInvoice(prisma, row.documentId, actor.actorId, {
        ...(input.sentTo?.trim() ? { dispatchedTo: input.sentTo.trim() } : {}),
      });
      sentTo = (inv as { dispatchedTo?: string | null }).dispatchedTo ?? input.sentTo?.trim() ?? null;
    }
  } else if (input.action === "WHATSAPP") {
    if (row.kind === "PROFORMA") {
      throw new ValidationError("A bill is sent by email — WhatsApp is not recorded for a bill. Send it by email, or don't send it.");
    }
    sentTo = input.sentTo?.trim() || null;
  }

  const decision = input.action === "EMAIL" ? "SENT_EMAIL" : input.action === "WHATSAPP" ? "SENT_WHATSAPP" : "NOT_SENT";
  const now = new Date();
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
  return view(updated, { to: null, whose: null });
}
