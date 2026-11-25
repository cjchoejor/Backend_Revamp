import { assignedRoomNights, roomsWithNightsLine, type NightsMode } from "../../lib/room-nights-for-entry.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { effectiveCheckOutDate } from "../../lib/stay-dates.js";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { formatMoney, loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { stayOutcomeRows, type StayInfoRow } from "../../lib/stay-outcome-words.js";
import { toDecimal } from "../../lib/money.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import {
  formatDocDateTimeLocal,
  formatStayLines,
  localYmd,
} from "../infrastructure/pdf-templates/legphel-document-format.js";
import {
  renderLegphelInterimStatementHtml,
  renderLegphelMasterBillHtml,
  type FolioBillBody,
} from "../infrastructure/pdf-templates/legphel-folio-statement-templates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { sendEmail } from "../infrastructure/email-service.js";
import { emailsGoAfterAnswer, runAfterAnswer } from "../../lib/outbox.js";
import { renderFolioStatementEmail } from "../infrastructure/stage-email-templates.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import { resolveInvoiceRecipient } from "./s9-service.js";
import {
  buildFinalInvoiceFigures,
  composeTaxInvoiceHtml,
  guestsWords,
  paperBillRows,
  paperPaymentRows,
  ratePercentLabel,
  roomsWords,
  taxInvoicePartiesFromEntry,
  type FinalInvoiceFigures,
} from "./invoice-pdf-service.js";

/**
 * FOLIO DOCUMENTS — the in-stay and checkout bills that are VIEWS of the one folio (2026-08-22,
 * operator request: "tentative invoice, tax invoice, master invoice — all indicative in S7; final
 * in S8"). Mapped onto DFG-001 (docs/bills):
 *
 *   tentative invoice  → C5 Interim Folio Statement  "Position to date — not a bill for settlement"
 *   master invoice     → C1 Master Bill              "Statement — not a tax invoice" (the rollup)
 *   tax invoice        → B1 Tax Invoice              DRAFT until issued at settlement
 *
 * WHEN each exists, and why (DFG-001 §G1 "the three gates"):
 *   - Folio LIVE (S7, and S8 before money is taken): nothing is sealed. All three are views that
 *     regenerate on demand — no row, no number; every render is a snapshot "as at" now. The tax
 *     invoice renders as a DRAFT (watermark, no serial) so the fiscal particulars can be checked
 *     before the one original is issued; it is NOT a handout — the interim statement is.
 *   - Gate 1, the folio seal (settlement → SETTLED / OUTSTANDING): the Master Bill's content
 *     freezes; further renders are REPRINTS carrying an ordinal (`FOLIO.MASTER_BILL_PRINTED`
 *     traces count them). The interim statement retires — its job (preventing checkout surprise)
 *     is over.
 *   - Gate 2, the fiscal issue (`issueInvoiceAtS8` → the FINAL Invoice row): the draft retires
 *     and the issued document is served ONLY from its write-once PDF (`/api/invoices/:id/pdf`) —
 *     recomposing an issued fiscal document from a ledger that can still take post-stay charges
 *     would print tomorrow's figures under today's serial.
 *
 * All three read the SAME ledger view as the issued tax invoice (`buildFinalInvoiceFigures` →
 * lib/folio-ledger-view.ts), so the rollup, the statement and the invoice reconcile to the
 * chethrum — "the rollup governs on any divergence" has no divergence to govern.
 *
 * Numbering: the reference gives the statements their own series (LH/MB, LH/IF). That needs
 * the series allocator + issuance register (handbook §08) — not built; until then a print is
 * identified by booking ref + as-at stamp, and the footline says so.
 */

export const FOLIO_DOCUMENT_KINDS = ["interim-statement", "master-bill", "tax-invoice"] as const;
export type FolioDocumentKind = (typeof FOLIO_DOCUMENT_KINDS)[number];

export function isFolioDocumentKind(v: string): v is FolioDocumentKind {
  return (FOLIO_DOCUMENT_KINDS as readonly string[]).includes(v);
}

export const MASTER_BILL_PRINT_EVENT = "FOLIO.MASTER_BILL_PRINTED";

const SEALED_STATES = new Set(["SETTLED", "OUTSTANDING", "WRITTEN_OFF", "NO_SHOW_CLOSED"]);

const CONTEXT_INCLUDE = {
  guestProfile: true,
  reservation: true,
  inquiry: { include: { travelAgent: true, corporateAccount: true } },
  folio: {
    include: {
      lines: { include: { room: { select: { roomNumber: true } } } },
      payments: true,
      invoices: { orderBy: { createdAt: "desc" as const } },
      writeOffRecords: true,
    },
  },
  roomAssignments: { include: { room: { select: { roomNumber: true } } } },
} satisfies Prisma.EntryInclude;

type Context = Prisma.EntryGetPayload<{ include: typeof CONTEXT_INCLUDE }>;

async function loadContext(prisma: PrismaClient, entryId: string): Promise<Context> {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: CONTEXT_INCLUDE });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

function folioSealedAt(folio: Context["folio"]): Date | null {
  if (!folio || !SEALED_STATES.has(folio.state)) return null;
  return folio.closedAt ?? null;
}

function stayFrame(entry: Context): { checkIn: Date | null; checkOut: Date | null; nights: number | null } {
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  // Early departure (2026-08-22): the statements frame the stay as it really ended.
  const checkOut = effectiveCheckOutDate(entry);
  const nights =
    checkIn && checkOut ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000)) : null;
  return { checkIn, checkOut, nights };
}

/** Distinct room numbers of the plan, numeric order — the statements' "Rooms" row. */
function roomNumbersOf(entry: Context): string[] {
  return Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((n): n is string => !!n))).sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );
}

function newestFinalInvoice(folio: Context["folio"]) {
  return (folio?.invoices ?? []).find((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED") ?? null;
}

/** Sealed Master Bill reprints so far — the ordinal the NEXT print carries (first print = 0). */
async function masterBillPrintCount(prisma: PrismaClient, entryId: string, since: Date): Promise<number> {
  return prisma.traceEvent.count({ where: { entryId, eventType: MASTER_BILL_PRINT_EVENT, timestamp: { gte: since } } });
}

// ---------------------------------------------------------------------------------------------
// The index — what documents this booking has, in which state, and why. The desk (and the
// production frontend) read states from here instead of deriving them.
// ---------------------------------------------------------------------------------------------

export type FolioDocumentEntry = {
  kind: FolioDocumentKind;
  /** Operator name + the reference document it is. */
  title: string;
  subtitle: string;
  /** Why this document exists at this point of the stay — the desk prints it. */
  purpose: string;
  available: boolean;
  /** Why it is not available right now (null when available). */
  unavailableReason: string | null;
  state: "SNAPSHOT" | "INDICATIVE" | "FROZEN" | "DRAFT" | "ISSUED" | "NONE";
  /** Sealed Master Bill: how many prints so far. */
  reprintCount: number | null;
  frozenAt: string | null;
  /** The last time the desk sent it (2026-11-10): by email or recorded as sent on WhatsApp. */
  sent: { at: string; channel: "EMAIL" | "WHATSAPP"; to: string | null } | null;
  /** Issued tax invoice: the Invoice row to open via `/api/invoices/:id/pdf`. */
  invoice: {
    id: string;
    invoiceNumber: string | null;
    state: string;
    pdfReady: boolean;
    issuedAt: string | null;
    dispatchedAt: string | null;
    /** The address the invoice was emailed to — null when it went out with no email (2026-09-18). */
    dispatchedTo: string | null;
  } | null;
};

export type FolioDocumentsIndex = {
  entryId: string;
  stage: string;
  folioId: string | null;
  folioState: string | null;
  /** Gate 1 — settlement sealed the folio at this instant. */
  sealedAt: string | null;
  asAt: string;
  documents: FolioDocumentEntry[];
};

export async function listFolioDocuments(prisma: PrismaClient, entryId: string): Promise<FolioDocumentsIndex> {
  const entry = await loadContext(prisma, entryId);
  const folio = entry.folio;
  const sealedAt = folioSealedAt(folio);
  const live = folio?.state === "LIVE";
  const hasLines = (folio?.lines.length ?? 0) > 0;
  const stage = entry.currentStage;
  const finalInvoice = newestFinalInvoice(folio);
  const reprintCount = folio && sealedAt ? await masterBillPrintCount(prisma, entryId, sealedAt) : null;
  const sentOf = await lastSentByKind(prisma, entryId);

  const noFolio = !folio ? "No bill yet — it starts at Set up and goes live at check-in." : null;
  const notLive = folio && folio.state === "PROVISIONAL" ? "The bill goes live at check-in — nothing is charged before that." : null;

  const interim: FolioDocumentEntry = {
    kind: "interim-statement",
    title: "Tentative invoice",
    subtitle: "Where the guest stands so far",
    purpose:
      "What the guest has been charged so far and what they have paid — to hand over during the stay. It is not the final bill: charges continue until check-out, and each copy shows the moment it was made.",
    available: !!folio && live && stage === "S7",
    unavailableReason:
      noFolio ??
      notLive ??
      (sealedAt ? "The bill is settled — the master bill is the bill now." : stage !== "S7" ? "Only during the stay — at check-out the master bill is the bill." : null),
    state: !!folio && live && stage === "S7" ? "SNAPSHOT" : "NONE",
    reprintCount: null,
    frozenAt: null,
    sent: sentOf.get("interim-statement") ?? null,
    invoice: null,
  };

  const masterAvailable = !!folio && hasLines && (live || !!sealedAt);
  const master: FolioDocumentEntry = {
    kind: "master-bill",
    title: "Master bill",
    subtitle: "Every charge by kind, and what is owed",
    purpose: sealedAt
      ? "The final bill: every charge by kind and what was paid. It no longer changes; each copy printed or sent is numbered."
      : "Every charge by kind and what has been paid so far — the bill the guest signs at check-out. Until then it shows the bill as it stands.",
    available: masterAvailable,
    unavailableReason: noFolio ?? notLive ?? (!hasLines ? "Nothing charged on the bill yet." : null),
    state: !masterAvailable ? "NONE" : sealedAt ? "FROZEN" : "INDICATIVE",
    reprintCount,
    frozenAt: sealedAt?.toISOString() ?? null,
    sent: sentOf.get("master-bill") ?? null,
    invoice: null,
  };

  const draftAvailable = !finalInvoice && !!folio && hasLines && (live || !!sealedAt);
  const tax: FolioDocumentEntry = {
    kind: "tax-invoice",
    title: "Tax invoice",
    subtitle: "The numbered bill for tax",
    purpose: finalInvoice
      ? "The numbered bill for tax, issued once and never changed. Every copy is the same original."
      : "How the tax invoice will read — to check the name, the tax number and the charges before it is issued. It gets its number when the bill is settled, and is not handed to the guest before then.",
    available: !!finalInvoice || draftAvailable,
    unavailableReason: finalInvoice ? null : noFolio ?? notLive ?? (!hasLines ? "Nothing charged on the bill yet." : null),
    state: finalInvoice ? "ISSUED" : draftAvailable ? "DRAFT" : "NONE",
    reprintCount: null,
    frozenAt: null,
    sent: null,
    invoice: finalInvoice
      ? {
          id: finalInvoice.id,
          invoiceNumber: finalInvoice.invoiceNumber ?? finalInvoice.id,
          state: finalInvoice.state,
          pdfReady: !!finalInvoice.pdfStorageKey,
          issuedAt: finalInvoice.issuedAt?.toISOString() ?? null,
          dispatchedAt: finalInvoice.dispatchedAt?.toISOString() ?? null,
          dispatchedTo: finalInvoice.dispatchedTo ?? null,
        }
      : null,
  };

  return {
    entryId,
    stage,
    folioId: folio?.id ?? null,
    folioState: folio?.state ?? null,
    sealedAt: sealedAt?.toISOString() ?? null,
    asAt: new Date().toISOString(),
    documents: [interim, master, tax],
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

type Composed = {
  entry: Context;
  figures: FinalInvoiceFigures;
  rates: { gstRate: number; svcRate: number };
  hotel: Awaited<ReturnType<typeof loadHotelProfileForRender>>;
  account: string;
  forGuest: string | null;
  stay: ReturnType<typeof stayFrame>;
  /** How a stay that ended early ended (2026-11-25) — `lib/stay-outcome-words`. */
  stayOutcome: StayInfoRow[] | null;
  rooms: string[];
  /** "Room 201 (10–19 Mar) · Room 202 (10–14 Mar)" — each room with its nights (2026-10-30). */
  roomsLine: string | null;
  sealedAt: Date | null;
  asAt: Date;
};

async function compose(prisma: PrismaClient, entryId: string, opts?: { nightsMode?: NightsMode }): Promise<Composed> {
  const entry = await loadContext(prisma, entryId);
  if (!entry.folio) throw new ValidationError("This booking has no folio yet — nothing to bill.");
  const [hotel, { gstRate, serviceChargeRate: svcRate }] = await Promise.all([loadHotelProfileForRender(prisma), resolveChargeRates(prisma)]);
  const stay = stayFrame(entry);
  const figures = buildFinalInvoiceFigures(
    { billingModel: null, folio: entry.folio },
    { gstRate, svcRate, nights: Math.max(1, stay.nights ?? 1), nightlyRate: 0, nightsMode: opts?.nightsMode ?? "SHORT" },
  );
  const parties = taxInvoicePartiesFromEntry(entry);
  const assigned = await assignedRoomNights(prisma, entryId, stay).catch(() => []);
  const stayOutcome = await stayOutcomeRows(prisma, entryId).catch(() => null);
  return {
    stayOutcome,
    roomsLine: assigned.length ? roomsWithNightsLine(assigned, opts?.nightsMode ?? "SHORT") : null,
    entry,
    figures,
    rates: { gstRate, svcRate },
    hotel,
    account: parties.billedTo,
    forGuest: parties.forGuest,
    stay,
    rooms: roomNumbersOf(entry),
    sealedAt: folioSealedAt(entry.folio),
    asAt: new Date(),
  };
}

/** "3 slept · 4 to come" on the property's calendar — null when the stay has no dates. */
function nightsLine(stay: ReturnType<typeof stayFrame>, now: Date): string | null {
  if (!stay.checkIn || stay.nights == null) return null;
  const today = localYmd(now);
  const ci = stay.checkIn.toISOString().slice(0, 10);
  const elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ci}T00:00:00Z`)) / 86_400_000);
  const slept = Math.min(stay.nights, Math.max(0, elapsed));
  return `${slept} slept · ${stay.nights - slept} to come`;
}

/**
 * The middle of the Master Bill and the Tentative invoice (2026-11-25): who the bill is to and the
 * stay side by side, the rooms, every charge on its own row, the ladder, the payments, the balance.
 * Every figure is the ledger's own (`buildFinalInvoiceFigures`); the balance is the folio's stored
 * outstanding balance, as before.
 */
function billBody(c: Composed, stayExtra: Array<{ k: string; v: string; strong?: boolean } | null>): FolioBillBody {
  const f = c.figures;
  const folio = c.entry.folio!;
  const stay = c.stay.checkIn && c.stay.checkOut ? formatStayLines(c.stay.checkIn, c.stay.checkOut, c.stay.nights) : null;
  const scPct = ratePercentLabel(f.ladder.serviceCharge, f.ladder.net, c.rates.svcRate);
  const gstPct = ratePercentLabel(f.ladder.gst, f.ladder.taxable, c.rates.gstRate);
  const balance = toDecimal(folio.outstandingBalance);
  const owed = balance.gt(0);
  return {
    billTo: {
      heading: "Bill to",
      rows: [
        { k: "Name", v: c.account, strong: true },
        c.forGuest ? { k: "For guest", v: c.forGuest } : null,
        (() => {
          const g = guestsWords(c.entry);
          return g ? { k: "Guests", v: g } : null;
        })(),
      ],
    },
    stay: {
      heading: "Stay",
      rows: [
        { k: "Booking", v: c.entry.id, red: true },
        { k: "Folio", v: folio.id, mono: true },
        stay ? { k: "Check-in", v: stay.checkIn, strong: true } : null,
        ...(c.stayOutcome?.length ? c.stayOutcome : [stay ? { k: "Check-out", v: stay.checkOut } : null]),
        ...stayExtra,
      ],
    },
    rooms: roomsWords(c.rooms),
    lines: paperBillRows(f),
    ladder: [
      { label: "Net value", value: formatMoney(f.ladder.net) },
      { label: `Service charge ${scPct}%`, value: formatMoney(f.ladder.serviceCharge) },
      { label: `GST @ ${gstPct}% on net value and service charge`, value: formatMoney(f.ladder.gst) },
    ],
    totalLabel: "Total · Nu.",
    total: formatMoney(f.ladder.total),
    byKind: f.components.map((k) => ({ label: k.key === "ROOM" ? `Accommodation · ${k.roomNights} room-night${k.roomNights === 1 ? "" : "s"}` : k.label, amount: formatMoney(k.total) })),
    payments: paperPaymentRows(f, folio.writeOffRecords ?? []),
    balanceLabel: balance.lt(0) ? "Paid over the bill · Nu." : "Balance due · Nu.",
    balance: formatMoney(balance.abs().toFixed(2)),
    owed,
  };
}

function renderInterimStatement(c: Composed): string {
  if (c.entry.folio?.state !== "LIVE" || c.entry.currentStage !== "S7") {
    throw new ValidationError("The interim folio statement is issued during the stay only (S7, folio live) — at check-out the Master Bill is the bill.");
  }
  const nights = nightsLine(c.stay, c.asAt);
  return renderLegphelInterimStatementHtml({
    masthead: mastheadFromHotelProfile(c.hotel),
    statementNo: null,
    bookingRef: c.entry.id,
    strip: "Position to date — not a bill for settlement",
    ...billBody(c, [nights ? { k: "Nights", v: nights } : null, { k: "As at", v: formatDocDateTimeLocal(c.asAt), strong: true }]),
    totalLabel: "Charges to date · Nu.",
    note:
      "Line amounts are before service charge and GST, which are added beneath them. Charges continue to post until check-out; the final amounts are on the master bill and the tax invoice.",
    tariffVersion: "T1.0",
    pageLabel: "snapshot",
  });
}

const LIABILITY =
  "I agree that my liability for this bill is not waived, and that I am responsible for paying it if the person, company or agency named above does not pay any part or all of it.";

function renderMasterBill(c: Composed, opts: { reprintOrdinal: number | null }): string {
  const sealed = c.sealedAt != null;
  const atCheckout = sealed || c.entry.currentStage === "S8";
  const pageLabel = sealed ? `reprint ${opts.reprintOrdinal == null ? "preview" : opts.reprintOrdinal}` : "indicative";
  return renderLegphelMasterBillHtml({
    masthead: mastheadFromHotelProfile(c.hotel),
    billNo: null,
    bookingRef: c.entry.id,
    strip: sealed ? "Statement — not a tax invoice" : "Statement — not a tax invoice · indicative, charges still posting",
    ...billBody(c, [sealed ? { k: "Bill closed", v: formatDocDateTimeLocal(c.sealedAt!) } : { k: "As at", v: formatDocDateTimeLocal(c.asAt), strong: true }]),
    note: sealed
      ? `Line amounts are before service charge and GST, which are added beneath them. This bill was closed on ${formatDocDateTimeLocal(c.sealedAt!)}. The tax invoice is the fiscal document; please raise any query within 7 days.`
      : `Line amounts are before service charge and GST, which are added beneath them. The bill as it stands at ${formatDocDateTimeLocal(c.asAt)}; charges continue to post until check-out. Please raise queries before settlement — the tax invoice is issued at settlement.`,
    liability: atCheckout ? LIABILITY : null,
    signatures: atCheckout ? ["Guest / account signature", "Front office"] : null,
    tariffVersion: "T1.0",
    pageLabel,
  });
}

function renderTaxInvoiceDraft(c: Composed): string {
  const issued = newestFinalInvoice(c.entry.folio);
  if (issued) {
    throw new PolicyGateBlockedError(
      "TAX_INVOICE_ISSUED",
      `The tax invoice has been issued as ${issued.invoiceNumber ?? issued.id} — open the issued document; a fiscal document is never recomposed.`,
      { invoiceId: issued.id },
    );
  }
  return composeTaxInvoiceHtml({
    hotel: c.hotel,
    figures: c.figures,
    parties: taxInvoicePartiesFromEntry(c.entry),
    bookingRef: c.entry.id,
    folioId: c.entry.folio?.id ?? null,
    guests: guestsWords(c.entry),
    stay: c.stay,
    stayOutcome: c.stayOutcome,
    roomNumbers: c.rooms,
    roomsLine: c.roomsLine,
    issued: null,
    asAt: c.asAt,
    gstRate: c.rates.gstRate,
    svcRate: c.rates.svcRate,
    currency: c.entry.folio?.lines?.[0]?.currency ?? "BTN",
  });
}

function filenameFor(entryId: string, kind: FolioDocumentKind): string {
  return kind === "interim-statement"
    ? `${entryId}-interim-folio-statement.pdf`
    : kind === "master-bill"
      ? `${entryId}-master-bill.pdf`
      : `${entryId}-tax-invoice-draft.pdf`;
}

/**
 * The document as HTML — a pure read (no storage, no trace). A sealed Master Bill previews with
 * "reprint preview" in the footline; the ordinal belongs to an actual print.
 */
export async function renderFolioDocumentHtml(
  prisma: PrismaClient,
  entryId: string,
  kind: FolioDocumentKind,
  opts?: { nightsMode?: NightsMode },
): Promise<{ html: string; filename: string; asAt: Date }> {
  const c = await compose(prisma, entryId, opts);
  const html =
    kind === "interim-statement"
      ? renderInterimStatement(c)
      : kind === "master-bill"
        ? renderMasterBill(c, { reprintOrdinal: null })
        : renderTaxInvoiceDraft(c);
  return { html, filename: filenameFor(entryId, kind), asAt: c.asAt };
}

/**
 * The document as a PDF — rendered fresh, NEVER stored: these are snapshots (a statement's
 * identity is its as-at), not write-once instruments. A sealed Master Bill's print is the one
 * side effect: it is a Class-3 reprint, so it carries the next ordinal and writes the
 * `FOLIO.MASTER_BILL_PRINTED` trace that the ordinal is counted from.
 */
export async function printFolioDocumentPdf(
  prisma: PrismaClient,
  entryId: string,
  kind: FolioDocumentKind,
  actorId: string,
  opts?: { nightsMode?: NightsMode },
): Promise<{ bytes: Buffer; filename: string; reprintOrdinal: number | null }> {
  const c = await compose(prisma, entryId, opts);
  let html: string;
  let reprintOrdinal: number | null = null;
  if (kind === "master-bill") {
    if (c.sealedAt) reprintOrdinal = await masterBillPrintCount(prisma, entryId, c.sealedAt);
    html = renderMasterBill(c, { reprintOrdinal });
  } else if (kind === "interim-statement") {
    html = renderInterimStatement(c);
  } else {
    html = renderTaxInvoiceDraft(c);
  }
  const bytes = await renderHtmlToPdf(html, { fitToPage: true });
  if (kind === "master-bill" && c.sealedAt) {
    await prisma.traceEvent.create({
      data: {
        eventType: MASTER_BILL_PRINT_EVENT,
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Folio",
        entityId: c.entry.folio!.id,
        operation: "CREATE",
        timestamp: c.asAt,
        entryId,
        payload: { reprintOrdinal, sealedAt: c.sealedAt.toISOString(), total: c.figures.ladder.total, balance: Number(toDecimal(c.entry.folio!.outstandingBalance).toFixed(2)) },
        createdBy: actorId,
      } as Prisma.TraceEventUncheckedCreateInput,
    });
  }
  return { bytes, filename: filenameFor(entryId, kind), reprintOrdinal };
}

// ---------------------------------------------------------------------------------------------
// Sending (2026-11-10, operator: "make the view like how we view other papers, also show the send
// button"). The statement so far and the master bill go out by email with the paper attached, or
// are recorded as sent on WhatsApp. A tax invoice goes out once it is issued, from its own row —
// a draft has no number and is never sent.
// ---------------------------------------------------------------------------------------------

export const FOLIO_DOCUMENT_SENT_EVENT = "FOLIO.DOCUMENT_SENT";

async function lastSentByKind(prisma: PrismaClient, entryId: string): Promise<Map<FolioDocumentKind, NonNullable<FolioDocumentEntry["sent"]>>> {
  const rows = await prisma.traceEvent.findMany({
    where: { entryId, eventType: FOLIO_DOCUMENT_SENT_EVENT },
    orderBy: { timestamp: "desc" },
    take: 20,
    select: { timestamp: true, payload: true },
  });
  const out = new Map<FolioDocumentKind, NonNullable<FolioDocumentEntry["sent"]>>();
  for (const r of rows) {
    const p = (r.payload ?? {}) as { kind?: string; channel?: string; to?: string | null };
    if (!p.kind || !isFolioDocumentKind(p.kind) || out.has(p.kind)) continue;
    out.set(p.kind, { at: r.timestamp.toISOString(), channel: p.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL", to: p.to ?? null });
  }
  return out;
}

export type FolioDocumentSendOutcome = {
  kind: FolioDocumentKind;
  channel: "EMAIL" | "WHATSAPP";
  to: string;
  /** EMAIL: whether the mail went out; false with the reason when it was switched off or failed. */
  emailed: boolean;
  /** EMAIL on the API server: on its way, sent right after this answer (2026-11-10). */
  queued?: boolean;
  reason: string | null;
  reprintOrdinal: number | null;
};

export async function sendFolioDocument(
  prisma: PrismaClient,
  entryId: string,
  kind: FolioDocumentKind,
  actorId: string,
  input: { channel: "EMAIL" | "WHATSAPP"; to?: string | null; nightsMode?: NightsMode },
): Promise<FolioDocumentSendOutcome> {
  if (kind === "tax-invoice") {
    throw new PolicyGateBlockedError(
      "TAX_INVOICE_SENT_FROM_ITS_OWN_ROW",
      "A tax invoice is sent once it is issued, with its number — a draft is never sent. Issue it, then send it from its own row.",
    );
  }
  const index = await listFolioDocuments(prisma, entryId);
  const doc = index.documents.find((d) => d.kind === kind);
  if (!doc?.available) throw new ValidationError(doc?.unavailableReason ?? "This paper is not available on this booking now.");
  const entry = await loadContext(prisma, entryId);
  const paperName = kind === "master-bill" ? "Your bill" : "Your bill so far";

  let to: string;
  if (input.channel === "WHATSAPP") {
    const phone = cleanPhone(input.to, "The WhatsApp number");
    if (!phone) throw new ValidationError("Type the WhatsApp number it was sent to.");
    to = phone;
  } else {
    const r = await resolveInvoiceRecipient(prisma, entryId, input.to);
    if (!r.to) throw new ValidationError("There is no email on file for this booking — type the address to send it to.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.to)) throw new ValidationError(`"${r.to}" is not an email address.`);
    to = r.to;
  }

  let emailed = false;
  let reason: string | null = null;
  let reprintOrdinal: number | null = null;
  let messageId: string | null = null;
  if (input.channel === "EMAIL") {
    // The copy that goes out is a print like any other — a sealed master bill's carries its number.
    const pdf = await printFolioDocumentPdf(prisma, entryId, kind, actorId, { nightsMode: input.nightsMode });
    reprintOrdinal = pdf.reprintOrdinal;
    const c = await compose(prisma, entryId);
    const who = await resolveInvoiceRecipient(prisma, entryId, to);
    const content = renderFolioStatementEmail({
      recipientName: who.greetName,
      bookingRef: entryId,
      paperName,
      checkInDate: c.stay.checkIn,
      checkOutDate: c.stay.checkOut,
      currency: entry.folio?.lines?.[0]?.currency ?? "BTN",
      total: c.figures.ladder.total,
      balance: Number(toDecimal(entry.folio!.outstandingBalance).toFixed(2)),
      stillStaying: entry.currentStage === "S7" && !c.sealedAt,
    });
    // The desk does not wait for the mail server (2026-11-10): on the API server the email goes
    // right after the answer, and the send is recorded once it went.
    const deliver = async () => {
      const result = await sendEmail(prisma, {
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
        threadEntryId: entryId,
        threadReadableId: entry.inquiryId,
        attachments: [{ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" }],
        paperKind: "BILL",
      });
      if (result.status === "sent") {
        emailed = true;
        messageId = result.messageId;
        await recordSent();
      } else {
        reason = result.status === "skipped" ? "Email is switched off on this server" : result.message;
        await prisma.traceEvent.create({
          data: {
            eventType: "FOLIO.DOCUMENT_NOT_EMAILED",
            actorId,
            actorLevel: "SYSTEM",
            entityType: "Folio",
            entityId: entry.folio!.id,
            operation: "DISPATCH",
            timestamp: new Date(),
            stageContext: entry.currentStage,
            inquiryId: entry.inquiryId,
            entryId,
            payload: { kind, paper: doc.title, to, reason },
            createdBy: actorId,
          } as Prisma.TraceEventUncheckedCreateInput,
        });
      }
    };
    if (emailsGoAfterAnswer() && (process.env.EMAIL_DISABLE ?? "").toLowerCase() !== "true") {
      await runAfterAnswer(entryId, `${doc.title} for ${entryId}`, deliver);
      return { kind, channel: input.channel, to, emailed: true, queued: true, reason: null, reprintOrdinal };
    }
    await deliver();
    return { kind, channel: input.channel, to, emailed, reason, reprintOrdinal };
  }

  await recordSent();
  return { kind, channel: input.channel, to, emailed, reason, reprintOrdinal };

  // Recorded only when it went: an email that failed is not a send.
  async function recordSent() {
    await prisma.traceEvent.create({
      data: {
        eventType: FOLIO_DOCUMENT_SENT_EVENT,
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Folio",
        entityId: entry!.folio!.id,
        operation: "DISPATCH",
        timestamp: new Date(),
        stageContext: entry!.currentStage,
        inquiryId: entry!.inquiryId,
        entryId,
        payload: { kind, paper: doc!.title, channel: input.channel, to, reprintOrdinal, messageId },
        createdBy: actorId,
      } as Prisma.TraceEventUncheckedCreateInput,
    });
  }
}
