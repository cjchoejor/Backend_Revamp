import type { Prisma, PrismaClient } from "@prisma/client";
import { effectiveCheckOutDate } from "../../lib/stay-dates.js";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { formatMoney, loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { toDecimal } from "../../lib/money.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import {
  formatDocDateTimeLocal,
  formatStayRange,
  localYmd,
} from "../infrastructure/pdf-templates/legphel-document-format.js";
import {
  renderLegphelInterimStatementHtml,
  renderLegphelMasterBillHtml,
} from "../infrastructure/pdf-templates/legphel-folio-statement-templates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import {
  buildFinalInvoiceFigures,
  composeTaxInvoiceHtml,
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
  /** Issued tax invoice: the Invoice row to open via `/api/invoices/:id/pdf`. */
  invoice: { id: string; invoiceNumber: string | null; state: string; pdfReady: boolean; issuedAt: string | null; dispatchedAt: string | null } | null;
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

  const noFolio = !folio ? "No folio yet — the bill starts at Set up (S3) and goes live at check-in." : null;
  const notLive = folio && folio.state === "PROVISIONAL" ? "The folio goes live at check-in — nothing is posted before that." : null;

  const interim: FolioDocumentEntry = {
    kind: "interim-statement",
    title: "Tentative invoice",
    subtitle: "Interim folio statement (C5)",
    purpose:
      "The mid-stay handout: where the guest stands right now — charges to date by component, money received, the position. Not a bill for settlement; every print is a fresh snapshot.",
    available: !!folio && live && stage === "S7",
    unavailableReason:
      noFolio ??
      notLive ??
      (sealedAt ? "The stay is settled — the Master Bill is the position now." : stage !== "S7" ? "Only during the stay (S7) — at check-out the Master Bill is the bill." : null),
    state: !!folio && live && stage === "S7" ? "SNAPSHOT" : "NONE",
    reprintCount: null,
    frozenAt: null,
    invoice: null,
  };

  const masterAvailable = !!folio && hasLines && (live || !!sealedAt);
  const master: FolioDocumentEntry = {
    kind: "master-bill",
    title: "Master bill",
    subtitle: "Master Bill (C1) — the rollup",
    purpose: sealedAt
      ? "Content frozen at the folio seal (settlement). Reprints carry an ordinal; the figures never move."
      : "The rollup by component with the settlement position — the bill presented for signature at check-out. In-stay it is the same rollup, indicative, as at printing.",
    available: masterAvailable,
    unavailableReason: noFolio ?? notLive ?? (!hasLines ? "Nothing posted on the folio yet." : null),
    state: !masterAvailable ? "NONE" : sealedAt ? "FROZEN" : "INDICATIVE",
    reprintCount,
    frozenAt: sealedAt?.toISOString() ?? null,
    invoice: null,
  };

  const draftAvailable = !finalInvoice && !!folio && hasLines && (live || !!sealedAt);
  const tax: FolioDocumentEntry = {
    kind: "tax-invoice",
    title: "Tax invoice",
    subtitle: finalInvoice ? "Tax Invoice (B1) — issued" : "Tax Invoice (B1) — draft",
    purpose: finalInvoice
      ? "The fiscal document, issued once and never revised. Served from the stored original; corrections travel as adjustment notes."
      : "The fiscal document as it would issue now — a DRAFT with no serial, for checking the billed-to party, TPN, descriptions and the GST ladder before the one original is issued at settlement. Not a handout.",
    available: !!finalInvoice || draftAvailable,
    unavailableReason: finalInvoice ? null : noFolio ?? notLive ?? (!hasLines ? "Nothing posted on the folio yet." : null),
    state: finalInvoice ? "ISSUED" : draftAvailable ? "DRAFT" : "NONE",
    reprintCount: null,
    frozenAt: null,
    invoice: finalInvoice
      ? {
          id: finalInvoice.id,
          invoiceNumber: finalInvoice.invoiceNumber ?? finalInvoice.id,
          state: finalInvoice.state,
          pdfReady: !!finalInvoice.pdfStorageKey,
          issuedAt: finalInvoice.issuedAt?.toISOString() ?? null,
          dispatchedAt: finalInvoice.dispatchedAt?.toISOString() ?? null,
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
  rooms: string[];
  sealedAt: Date | null;
  asAt: Date;
};

async function compose(prisma: PrismaClient, entryId: string): Promise<Composed> {
  const entry = await loadContext(prisma, entryId);
  if (!entry.folio) throw new ValidationError("This booking has no folio yet — nothing to bill.");
  const [hotel, { gstRate, serviceChargeRate: svcRate }] = await Promise.all([loadHotelProfileForRender(prisma), resolveChargeRates(prisma)]);
  const stay = stayFrame(entry);
  const figures = buildFinalInvoiceFigures(
    { billingModel: null, folio: entry.folio },
    { gstRate, svcRate, nights: Math.max(1, stay.nights ?? 1), nightlyRate: 0 },
  );
  const parties = taxInvoicePartiesFromEntry(entry);
  return {
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

function componentContents(c: FinalInvoiceFigures["components"][number]): string {
  if (c.key === "ROOM") {
    const nights = `${c.roomNights} room-night${c.roomNights === 1 ? "" : "s"}`;
    return c.roomNumbers.length > 0 ? `${nights} · Room${c.roomNumbers.length === 1 ? "" : "s"} ${c.roomNumbers.join(", ")}` : nights;
  }
  const digest = c.descriptions
    .slice(0, 3)
    .map((d) => (d.length > 30 ? `${d.slice(0, 29)}…` : d))
    .join(" · ");
  const more = c.descriptions.length > 3 ? ` +${c.descriptions.length - 3} more` : "";
  return digest ? `${digest}${more}` : `${c.chargeCount} item${c.chargeCount === 1 ? "" : "s"}`;
}

/** The money lines under a total: receipts in, refunds out, write-offs — each with its reference. */
function moneyLines(c: Composed): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const ins = c.figures.payments.filter((p) => p.direction === "IN");
  const outs = c.figures.payments.filter((p) => p.direction === "OUT");
  if (ins.length > 4) {
    out.push({ label: `Advance / payments received (${ins.length} receipts)`, value: `−${formatMoney(ins.reduce((s, p) => s + p.amount, 0))}` });
  } else {
    for (const p of ins) out.push({ label: `Advance / payment received · ${p.id}`, value: `−${formatMoney(p.amount)}` });
  }
  for (const p of outs) out.push({ label: `Refunded · ${p.id}`, value: `+${formatMoney(p.amount)}` });
  for (const w of c.entry.folio?.writeOffRecords ?? []) out.push({ label: `Written off · ${w.id}`, value: `−${formatMoney(toDecimal(w.writtenOffAmount).toFixed(2))}` });
  return out;
}

function renderInterimStatement(c: Composed): string {
  if (c.entry.folio?.state !== "LIVE" || c.entry.currentStage !== "S7") {
    throw new ValidationError("The interim folio statement is issued during the stay only (S7, folio live) — at check-out the Master Bill is the bill.");
  }
  return renderLegphelInterimStatementHtml({
    masthead: mastheadFromHotelProfile(c.hotel),
    statementNo: null,
    bookingRef: c.entry.id,
    strip: "Position to date — not a bill for settlement",
    asAt: formatDocDateTimeLocal(c.asAt),
    account: c.account,
    forGuest: c.forGuest,
    stay: c.stay.checkIn && c.stay.checkOut ? formatStayRange(c.stay.checkIn, c.stay.checkOut, c.stay.nights) : null,
    nightsLine: nightsLine(c.stay, c.asAt),
    rooms: c.rooms.length > 0 ? `Room${c.rooms.length === 1 ? "" : "s"} ${c.rooms.join(", ")}` : null,
    rows: c.figures.components.map((comp) => ({
      label: comp.key === "ROOM" ? "Room charges to date" : `${comp.label} to date`,
      value: formatMoney(comp.total),
    })),
    chargesToDate: formatMoney(c.figures.ladder.total),
    moneyLines: moneyLines(c),
    position: formatMoney(toDecimal(c.entry.folio.outstandingBalance).toFixed(2)),
    note:
      "All amounts include service charge and GST. Charges continue to post until checkout; final amounts on the Master Bill and the tax invoice.",
    tariffVersion: "T1.0",
    pageLabel: "Page 1 of 1 · snapshot",
  });
}

function renderMasterBill(c: Composed, opts: { reprintOrdinal: number | null }): string {
  const folio = c.entry.folio!;
  const sealed = c.sealedAt != null;
  const atCheckout = sealed || c.entry.currentStage === "S8";
  const ladder = c.figures.ladder;
  const position: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: `Payable by ${c.account}`, value: formatMoney(ladder.total) },
    ...moneyLines(c),
    { label: "Balance due", value: formatMoney(toDecimal(folio.outstandingBalance).toFixed(2)), bold: true },
  ];
  const pageLabel = sealed
    ? `Page 1 of 1 · reprint ${opts.reprintOrdinal == null ? "preview" : opts.reprintOrdinal}`
    : "Page 1 of 1 · indicative";
  return renderLegphelMasterBillHtml({
    masthead: mastheadFromHotelProfile(c.hotel),
    billNo: null,
    bookingRef: c.entry.id,
    strip: sealed ? "Statement — not a tax invoice" : "Statement — not a tax invoice · indicative, charges still posting",
    account: c.account,
    forGuest: c.forGuest,
    stay: c.stay.checkIn && c.stay.checkOut ? formatStayRange(c.stay.checkIn, c.stay.checkOut, c.stay.nights) : null,
    rooms: c.rooms.length > 0 ? `Room${c.rooms.length === 1 ? "" : "s"} ${c.rooms.join(", ")}` : null,
    asAtLabel: sealed ? "Content frozen at folio seal" : "As at",
    asAt: formatDocDateTimeLocal(sealed ? c.sealedAt! : c.asAt),
    rows: c.figures.components.map((comp) => ({
      component: comp.label,
      contents: componentContents(comp),
      amount: formatMoney(comp.total),
    })),
    total: formatMoney(ladder.total),
    ladderLine: `Net ${formatMoney(ladder.net)} · Service ${formatMoney(ladder.serviceCharge)} · Taxable ${formatMoney(ladder.taxable)} · GST ${formatMoney(ladder.gst)}`,
    position,
    note: sealed
      ? `All amounts include service charge and GST. Content frozen at folio seal, ${formatDocDateTimeLocal(c.sealedAt!)}. Itemised detail on the folio. The tax invoice is the fiscal document; please raise any query within 7 days.`
      : `All amounts include service charge and GST. Position as at printing, ${formatDocDateTimeLocal(c.asAt)}. Charges continue to post until checkout. Please raise queries before settlement; the tax invoice issues at settlement.`,
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
    stay: c.stay,
    roomNumbers: c.rooms,
    issued: null,
    asAt: c.asAt,
    gstRate: c.rates.gstRate,
    svcRate: c.rates.svcRate,
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
): Promise<{ html: string; filename: string; asAt: Date }> {
  const c = await compose(prisma, entryId);
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
): Promise<{ bytes: Buffer; filename: string; reprintOrdinal: number | null }> {
  const c = await compose(prisma, entryId);
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
