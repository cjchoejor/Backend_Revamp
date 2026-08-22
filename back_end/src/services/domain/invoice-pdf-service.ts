/**
 * Invoice PDF generation — S3 PROFORMA, S7 INTERIM and S8/S9 FINAL (the Tax Invoice).
 *
 * The PROFORMA uses the same visual template as S2 Quotation with the title swapped to
 * "PROFORMA INVOICE" (per boss's instruction "one template serves both").
 *
 * The FINAL invoice is the B1 Tax Invoice in the Legphel house format since 2026-08-22
 * (`legphel-tax-invoice-template.ts`, from docs/bills) — crimson fiscal family, category-level
 * rows, the downward ladder and the statutory GST sentence. Its figures come from the shared
 * ledger view (`lib/folio-ledger-view.ts`) through `buildFinalInvoiceFigures`, and the SAME
 * composition (`composeTaxInvoiceHtml`) renders the in-stay DRAFT the desk shows at S7/S8 before
 * issue — so what the desk checks mid-stay is, line for line, what is issued at settlement.
 * The pre-2026-08-22 "ROOM INVOICE" layout (`room-invoice-template.ts`) is retained only for
 * the write-once PDFs already stored under it.
 *
 * Both share:
 *   - Idempotent write-once storage (rendered once, served forever).
 *   - InvoiceLine snapshot.
 *   - renderInputSnapshot on the Invoice row for cold re-render decades later.
 *   - `INVOICE.PDF_GENERATED` trace event with the SHA-256 checksum.
 *
 * The PROFORMA document COMPOSITION is factored into `buildProformaDocRender` so the desk's
 * inline preview (`renderInvoicePreviewHtml`, 2026-08-01) shows the exact same document
 * WITHOUT rendering a PDF, writing storage, or snapshotting InvoiceLine rows.
 */
import { InvoiceType, Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { buildStorageKey, hashSha256, readDocument, writeDocument } from "../../lib/document-storage.js";
import {
  formatMoney,
  getPreparedByName,
  loadHotelProfileForRender,
  type HotelProfileForRender,
} from "../../lib/pdf-render-context.js";
import { sumMoney, toDecimal, ZERO } from "../../lib/money.js";
import {
  LEDGER_COMPONENTS,
  buildFolioLedgerView,
  legacyTaxOn,
  type LedgerComponentKey,
  type LedgerLineLike,
  type LedgerPaymentLike,
} from "../../lib/folio-ledger-view.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderLegphelInterimHtml, renderLegphelProformaHtml } from "../infrastructure/pdf-templates/legphel-proforma-template.js";
import { describeInterimPromise, type InterimFigures } from "./interim-payment-service.js";
import { mastheadFromHotelProfile, primaryContactNumber } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatDocDateTimeLocal, formatStayRange } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { renderLegphelTaxInvoiceHtml } from "../infrastructure/pdf-templates/legphel-tax-invoice-template.js";
import { computeStayCharges, resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import {
  describeAdvancePaymentPlan,
  evaluateAdvancePaymentCondition,
  resolveAdvancePaymentPlan,
  resolveOperatorAdvanceRequirement,
} from "./s3-payment-service.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";

type QuotationTerms = {
  roomCount?: number;
  roomTypeId?: string;
  effectiveRate?: string | number;
  currency?: string;
  pricingBreakdown?: { nightlyRate?: number | string; nights?: number; roomCount?: number };
  mealPlan?: string;
  extraBeds?: string | number;
} | null;

export type InvoicePdfArtifact = {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
  filename: string;
};

/** Nice filename for downloads / email attachments. */
function filenameFor(invoiceType: InvoiceType, invoiceRef: string): string {
  const label = invoiceType === InvoiceType.PROFORMA ? "proforma" : invoiceType === InvoiceType.INTERIM ? "interim-invoice" : "tax-invoice";
  return `${invoiceRef}-${label}.pdf`;
}

type LoadedInvoice = Prisma.InvoiceGetPayload<{
  include: {
    folio: { include: { lines: { include: { room: { select: { roomNumber: true } } } }; payments: true } };
    entry: {
      include: {
        guestProfile: true;
        reservation: true;
        inquiry: { include: { travelAgent: true; corporateAccount: true } };
        quotations: true;
        segments: true;
      };
    };
  };
}>;

export async function loadInvoiceForRender(prisma: PrismaClient, invoiceId: string): Promise<LoadedInvoice> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      folio: { include: { lines: { include: { room: { select: { roomNumber: true } } } }, payments: true } },
      entry: {
        include: {
          guestProfile: true,
          reservation: true,
          inquiry: { include: { travelAgent: true, corporateAccount: true } },
          // ALL quotations, not just ACCEPTED (fixed 2026-08-01): since the generate-vs-send
          // rule, a quote is often never formally accepted — the OPERATIVE quotation (accepted
          // → sent → draft, current segment) is the commercial basis, same as the S2→S3 gate.
          // Filtering to ACCEPTED here left `terms` null and printed a proforma with 0.00 in
          // every money row except the advance.
          quotations: { orderBy: { versionNumber: "desc" } },
          segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!inv) throw new NotFoundError("Invoice");
  return inv as LoadedInvoice;
}

/** Shared derivations both branches (and the proforma preview) start from. */
function invoicePrelude(inv: LoadedInvoice) {
  // The commercial basis: the operative quotation of the current segment (matches
  // resolveOperativeQuotation everywhere else), falling back to the newest ACCEPTED, then the
  // newest of any state — the document should show the best terms on file, not blanks.
  const segmentId = inv.entry.segments?.[0]?.id ?? null;
  const operative = segmentId ? resolveOperativeQuotation(inv.entry.quotations, segmentId) : null;
  const quotation =
    operative ?? inv.entry.quotations.find((q) => q.state === "ACCEPTED") ?? inv.entry.quotations[0] ?? null;
  const terms = (quotation?.commercialTerms as QuotationTerms) ?? null;

  const checkIn = inv.entry.reservation?.frozenCheckInDate ?? inv.entry.checkInDate ?? new Date();
  const rawCheckOut = inv.entry.reservation?.frozenCheckOutDate ?? inv.entry.checkOutDate ?? null;
  // Nights: the priced figure when the quote carries one, else the real stay length —
  // previously a missing terms value silently collapsed a 3-night stay to "1 night".
  const termNights = Number(terms?.pricingBreakdown?.nights ?? NaN);
  const dateNights = rawCheckOut
    ? Math.max(1, Math.round((rawCheckOut.getTime() - checkIn.getTime()) / 86_400_000))
    : NaN;
  const nights = Math.max(1, Number.isFinite(termNights) ? termNights : Number.isFinite(dateNights) ? dateNights : 1);
  const checkOut = rawCheckOut ?? new Date(checkIn.getTime() + nights * 86_400_000);

  const roomCount = Math.max(
    1,
    Number(terms?.roomCount ?? terms?.pricingBreakdown?.roomCount ?? inv.entry.numberOfRooms ?? 1),
  );
  const nightlyRate = Number(terms?.pricingBreakdown?.nightlyRate ?? terms?.effectiveRate ?? 0);

  const guest = inv.entry.guestProfile;
  const guestName = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ") || "Guest";
  const adultCount = inv.entry.adultCount ?? Number(inv.entry.guestCount ?? 1) ?? 1;
  const childCount = inv.entry.childCount ?? 0;
  // "3 adults" / "2 adults, 1 child" — the reference never prints ", 0 children".
  const occupantsString =
    `${adultCount} adult${adultCount === 1 ? "" : "s"}` +
    (childCount > 0 ? `, ${childCount} child${childCount === 1 ? "" : "ren"}` : "");
  const mealPlanCode = String(terms?.mealPlan ?? "").trim();
  const mealPlanDisplay = mealPlanCode ? `${adultCount + childCount} ${mealPlanCode}` : "";
  const extraBeds = terms?.extraBeds != null && String(terms.extraBeds).trim() && String(terms.extraBeds) !== "0" ? String(terms.extraBeds) : "None";

  return { terms, nights, roomCount, nightlyRate, guest, guestName, adultCount, childCount, occupantsString, mealPlanDisplay, extraBeds, checkIn, checkOut };
}

type ProformaPrintLine = {
  date: Date;
  roomNo?: string | null;
  occupants: string;
  mealPlan: string | null;
  extraBeds: string | null;
  amount: string | number;
};

/**
 * Compose the A2 house-format proforma from the invoice's CURRENT data. Pure read — no
 * writes, no storage. Both the stored-PDF path and the desk's live preview run through
 * here, so the two can never disagree.
 *
 * Advance semantics (2026-08-01, per the A2 reference — "the hero is the advance"):
 *   - Required = the desk's per-booking requirement (`Folio.advanceRequiredAmount`, flat or
 *     percent-resolved) when set; else the configured `advancePayment.thresholds` evaluation.
 *   - "Advance received" row appears once the guest has paid something in.
 *   - "Advance due now" = required − received (floor 0); with no requirement resolvable it
 *     falls back to the full remaining balance.
 *   - "Balance at checkout" = total − received − advance due now (floor 0).
 */
async function buildProformaDocRender(prisma: PrismaClient, inv: LoadedInvoice) {
  const hotel = await loadHotelProfileForRender(prisma);
  const p = invoicePrelude(inv);

  // Per-room composition path (Phase D, 2026-07-27). When frozenCommercialTerms carries
  // compositions, render one row per room. Falls back to legacy per-night rendering when
  // no composition (older bookings + non-composition callers).
  const compositionPerRoom = (p.terms as unknown as {
    compositionTotals?: {
      perRoom?: Array<{ roomId: string; roomNumber: string | null; total: number }>;
    };
    roomCompositions?: Array<any>;
  })?.compositionTotals?.perRoom;

  // Per-row Amount (Nu.) on Proforma is tax-INCLUSIVE — matches the Quotation convention.
  const perNightBreakdown = await computeStayCharges(prisma, p.nightlyRate, 1, p.roomCount);
  const perNightAmount = perNightBreakdown.total;
  // Full-stay breakdown for the legacy (non-composition) path — feeds the Total and the
  // Net/Service/GST decomposition, which previously printed 0.00 whenever compositionTotals
  // was absent.
  const stayCharges = await computeStayCharges(prisma, p.nightlyRate, p.nights, p.roomCount);

  const linesForTemplate: ProformaPrintLine[] = [];
  let totalAmount = 0;
  if (Array.isArray(compositionPerRoom) && compositionPerRoom.length > 0) {
    const inputsByRoomId = new Map(
      ((p.terms as any).roomCompositions ?? []).map((r: any) => [r.roomId, r]),
    );
    for (const r of compositionPerRoom) {
      const raw = inputsByRoomId.get(r.roomId) as any;
      const adults = raw?.adultCount ?? 0;
      const cnb = (raw?.cnb6To10Count ?? 0) + (raw?.cnbUnder6Count ?? 0);
      const rowOccupants = `${adults} adult${adults === 1 ? "" : "s"}${cnb > 0 ? `, ${cnb} child${cnb === 1 ? "" : "ren"}` : ""}`;
      const planParts: string[] = [];
      if (raw?.mealPlanCpCount) planParts.push(`${raw.mealPlanCpCount} CP`);
      if (raw?.mealPlanMaplCount) planParts.push(`${raw.mealPlanMaplCount} MAP+L`);
      if (raw?.mealPlanMapdCount) planParts.push(`${raw.mealPlanMapdCount} MAP+D`);
      if (raw?.mealPlanApCount) planParts.push(`${raw.mealPlanApCount} AP`);
      if (raw?.mealPlanOthersCount) planParts.push(`${raw.mealPlanOthersCount} Others`);
      const eb = raw?.extraBedCount && raw.extraBedCount > 0 ? `${raw.extraBedCount} extra bed${raw.extraBedCount === 1 ? "" : "s"}` : "None";
      linesForTemplate.push({
        date: p.checkIn,
        roomNo: r.roomNumber ?? r.roomId.slice(0, 6),
        occupants: rowOccupants,
        mealPlan: planParts.length > 0 ? planParts.join(" · ") : "EP (room only)",
        extraBeds: eb,
        amount: r.total,
      });
      totalAmount += Number(r.total);
    }
  } else {
    // Legacy per-night rendering.
    for (let i = 0; i < p.nights; i++) {
      const date = new Date(p.checkIn.getTime() + i * 86_400_000);
      linesForTemplate.push({
        date,
        occupants: p.occupantsString,
        mealPlan: p.mealPlanDisplay || null,
        extraBeds: p.extraBeds,
        amount: perNightAmount,
      });
    }
    // Decimal-safe full-stay total (was perNightAmount × nights in float).
    totalAmount = stayCharges.total;
  }

  // The reference's single rate line — "Deluxe · 1 room · 2 adults · MAP · per night". Room
  // type resolved from the quotation's terms; meal plans summarised across the composition
  // ("2 CP · 1 AP") or the legacy booking-wide plan.
  let roomTypeName: string | null = null;
  if (p.terms?.roomTypeId) {
    const rt = await prisma.roomType.findUnique({ where: { id: p.terms.roomTypeId }, select: { name: true } });
    roomTypeName = rt?.name ?? null;
  }
  const comps: any[] = ((p.terms as any)?.roomCompositions ?? []) as any[];
  const planAgg: Array<[string, number]> = [
    ["CP", comps.reduce((s, c) => s + (c?.mealPlanCpCount ?? 0), 0)],
    ["MAP+L", comps.reduce((s, c) => s + (c?.mealPlanMaplCount ?? 0), 0)],
    ["MAP+D", comps.reduce((s, c) => s + (c?.mealPlanMapdCount ?? 0), 0)],
    ["AP", comps.reduce((s, c) => s + (c?.mealPlanApCount ?? 0), 0)],
    ["Others", comps.reduce((s, c) => s + (c?.mealPlanOthersCount ?? 0), 0)],
  ];
  const planSummary =
    comps.length > 0
      ? planAgg.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(" · ") || "EP (room only)"
      : p.mealPlanDisplay || null;
  const rateLabel = [
    roomTypeName,
    `${p.roomCount} room${p.roomCount === 1 ? "" : "s"}`,
    p.occupantsString,
    planSummary,
    "per night",
  ]
    .filter(Boolean)
    .join(" · ");
  // Per-night figure consistent with the printed total (composition totals are stay-wide).
  const rateValue = Number((totalAmount / Math.max(1, p.nights)).toFixed(2));

  // === Advance figures ===
  const inPayments = (inv.folio?.payments ?? []).filter((pay) => pay.paymentDirection === "IN");
  const advanceReceived = inPayments.reduce((s, pay) => s + Number(toDecimal(pay.amount).toFixed(2)), 0);

  // The requirement: operator-pinned (Folio.advanceRequiredAmount) wins; else the configured
  // thresholds evaluation; else null (no requirement resolvable). The pin is SEGMENT-SCOPED
  // (2026-08-02, shared resolver): one set in a prior segment doesn't survive a re-entry, so
  // a new segment's proforma prints the configured default, not the old segment's figure.
  const currentSegmentForAdvance = await prisma.segment.findFirst({
    where: { entryId: inv.entryId },
    orderBy: { segmentNumber: "desc" },
    select: { startedAt: true },
  });
  const pinnedAdvance = inv.folio
    ? resolveOperatorAdvanceRequirement(inv.folio, currentSegmentForAdvance?.startedAt ?? null)
    : null;
  let requiredAdvance: number | null = pinnedAdvance != null ? Number(toDecimal(pinnedAdvance).toFixed(2)) : null;
  let advanceDueQualifier: string | null = null;
  const basis = (inv.folio?.advanceRequiredBasis ?? null) as { mode?: string; percent?: number } | null;
  if (requiredAdvance != null && basis?.mode === "PERCENT" && typeof basis.percent === "number") {
    advanceDueQualifier = `(${basis.percent}% of quote)`;
  }
  if (requiredAdvance == null && inv.folio) {
    try {
      const ev = await evaluateAdvancePaymentCondition(prisma, { entryId: inv.entryId, folioId: inv.folio.id });
      requiredAdvance = ev.requiredAmount > 0 ? ev.requiredAmount : null;
    } catch {
      /* advancePayment.thresholds not configured — fall through to full-balance semantics */
    }
  }

  const advanceDueNow = Math.max(0, Number(((requiredAdvance ?? totalAmount) - advanceReceived).toFixed(2)));
  const totalPayable = Number((totalAmount - advanceReceived).toFixed(2));
  const balanceAtCheckout = Math.max(0, Number((totalAmount - advanceReceived - advanceDueNow).toFixed(2)));

  // The guest's payment plan (2026-08-08, operator ruling: "select one and reflect that in the
  // PI") — segment-scoped like the requirement pin, printed only when one is recorded. The same
  // resolver feeds payment-status, so the document and the desk cannot disagree.
  const paymentPlan = inv.folio
    ? resolveAdvancePaymentPlan(inv.folio, currentSegmentForAdvance?.startedAt ?? null)
    : null;
  const advancePlanLabel = describeAdvancePaymentPlan(paymentPlan, formatDocDate);

  // The advance deadline — mirrors payment-status `advanceWindow.deadline`: the advance is due
  // between proforma dispatch and CHECK-IN, so the printed date is the check-in date (frozen at
  // S4 when a reservation exists). Read from the real columns, not the prelude's `checkIn` —
  // that one falls back to "today" for a dateless entry, and "Advance due by <today>" would be
  // a fabricated demand. Omitted once nothing is due (the template doc says exactly that).
  const advanceDeadline = inv.entry.reservation?.frozenCheckInDate ?? inv.entry.checkInDate ?? null;

  // A2 Proforma Invoice, house format (docs/bills). The Net / Service / GST figures decompose
  // the tax-inclusive total; they are not added to it.
  const ctP =
    (p.terms as unknown as {
      compositionTotals?: {
        subtotal?: string | number;
        serviceCharge?: string | number;
        gst?: string | number;
      };
    })?.compositionTotals ?? null;
  const invoiceRef = inv.invoiceNumber ?? inv.id;
  const docDate = inv.dispatchedAt ?? inv.issuedAt ?? new Date();

  // The billed party — the reference's "To" is the agency/corporate when one books
  // ("To: Bhutan Online Booking Travel / For guest: Dr Lakshmi Menon"), else the guest.
  const billedParty =
    inv.entry.inquiry?.travelAgent?.displayName ?? inv.entry.inquiry?.corporateAccount?.displayName ?? null;

  const html = renderLegphelProformaHtml({
    masthead: mastheadFromHotelProfile(hotel),
    proformaNo: invoiceRef,
    bookingRef: inv.entryId,
    date: formatDocDate(docDate),
    // "Advance due by <check-in date>" — the guest-facing validity of this document (2026-08-07,
    // operator request: the guest must see the deadline on the bill itself, like the quotation's
    // "Valid until" strip). See `advanceDeadline` above for where the date comes from.
    advanceDueBy: advanceDeadline && advanceDueNow > 0 ? formatDocDate(advanceDeadline) : null,
    to: billedParty ?? (p.guest?.email ? `${p.guestName} · ${p.guest.email}` : p.guestName),
    forGuest: p.guestName,
    stayLabel: "Stay",
    stay: formatStayRange(p.checkIn, p.checkOut, p.nights),
    rateLabel,
    rateValue: formatMoney(rateValue),
    totalInclusive: formatMoney(totalAmount),
    // Composition quotes decompose from their own priced totals; legacy quotes from the
    // stay-charge engine — never 0.00 placeholders.
    decompositionNet: formatMoney(ctP?.subtotal ?? stayCharges.subTotal),
    decompositionService: formatMoney(ctP?.serviceCharge ?? stayCharges.serviceCharge),
    decompositionGst: formatMoney(ctP?.gst ?? stayCharges.gst),
    advancePlanLabel,
    advanceReceived: advanceReceived > 0 ? formatMoney(advanceReceived) : null,
    // "(2 payments)" once installments are in — the guest sees how many they've made so far.
    advanceReceivedQualifier: inPayments.length > 1 ? `(${inPayments.length} payments)` : null,
    advanceDueQualifier,
    advanceDueNow: formatMoney(advanceDueNow),
    balanceAtCheckout: formatMoney(balanceAtCheckout),
    bank: {
      bankName: null,
      accountName: hotel.accountNumber ? `${hotel.hotelName} · ${hotel.accountNumber}` : null,
      accountsPhone: primaryContactNumber(hotel.contactNumbers) || null,
    },
    closingNote:
      "No surcharge applies on any payment mode. The booking confirms on receipt of the advance; " +
      "a confirmation voucher follows. Cancellation terms as disclosed for this booking.",
    tariffVersion: "T1.0",
  });

  return {
    html,
    linesForTemplate,
    perNightAmount,
    totalAmount,
    advanceReceived,
    requiredAdvance,
    advanceDueNow,
    balanceAtCheckout,
    totalPayable,
    invoiceRef,
    hotel,
    prelude: p,
  };
}

/**
 * INTERIM invoice document (2026-08-21) — printed from the FIGURES the interim request froze
 * when the ask was made (the request row carries them), so the bill the guest answers is the
 * bill the money is recorded against, whatever the ledger does meanwhile.
 */
export async function buildInterimDocRender(prisma: PrismaClient, inv: LoadedInvoice) {
  const hotel = await loadHotelProfileForRender(prisma);
  const req = await prisma.interimPaymentRequest.findUnique({
    where: { invoiceId: inv.id },
    include: { stayExtensionRequest: { select: { holdExpiresAt: true, state: true } } },
  });
  if (!req) throw new ValidationError("This interim invoice has no interim payment request behind it");
  const f = (req.figures ?? null) as InterimFigures | null;
  if (!f) throw new ValidationError("This interim invoice carries no figures");
  const p = invoicePrelude(inv);
  const invoiceRef = inv.invoiceNumber ?? inv.id;
  const docDate = inv.dispatchedAt ?? inv.issuedAt ?? new Date();
  const billedParty =
    inv.entry.inquiry?.travelAgent?.displayName ?? inv.entry.inquiry?.corporateAccount?.displayName ?? null;
  const checkIn = f.checkIn ? new Date(`${f.checkIn}T00:00:00.000Z`) : p.checkIn;
  const checkOut = f.checkOut ? new Date(`${f.checkOut}T00:00:00.000Z`) : p.checkOut;
  const inPayments = (inv.folio?.payments ?? []).filter((x) => x.paymentDirection === "IN");
  const ext = req.stayExtensionRequest;
  // The guest's promise, when recorded, replaces the plain due-by on the document.
  const promiseLine = describeInterimPromise(req, formatDocDate);
  const html = renderLegphelInterimHtml({
    masthead: mastheadFromHotelProfile(hotel),
    invoiceNo: invoiceRef,
    bookingRef: inv.entryId,
    date: formatDocDate(docDate),
    kind: req.kind,
    to: billedParty ?? (p.guest?.email ? `${p.guestName} · ${p.guest.email}` : p.guestName),
    forGuest: p.guestName,
    stay: formatStayRange(checkIn, checkOut, f.nightsTotal),
    nightsLine: `${f.nightsSlept} slept · ${f.nightsToCome} to come`,
    projectedRoomTotal: formatMoney(f.projectedRoomTotal),
    otherChargesSoFar: formatMoney(f.otherChargesSoFar),
    projectedTotal: formatMoney(f.projectedTotal),
    receivedSoFar: formatMoney(f.receivedSoFar),
    receivedQualifier: inPayments.length > 1 ? `(${inPayments.length} payments)` : null,
    askLabel: f.askLabel ?? "interim payment",
    dueNow: formatMoney(f.dueNow ?? 0),
    balanceAtCheckout: formatMoney(f.balanceAtCheckout ?? 0),
    dueBy: promiseLine ? null : req.dueBy ? formatDocDate(req.dueBy) : null,
    paymentPromise: promiseLine,
    holdUntil: ext && (ext.state === "REQUESTED" || ext.state === "BILLED") ? formatDocDate(ext.holdExpiresAt) : null,
    bank: {
      bankName: null,
      accountName: hotel.accountNumber ? `${hotel.hotelName} · ${hotel.accountNumber}` : null,
      accountsPhone: primaryContactNumber(hotel.contactNumbers) || null,
    },
    closingNote:
      req.kind === "EXTENSION"
        ? "The extra nights are reserved for you once this payment is received; the extension is confirmed by a re-issued voucher. No surcharge applies on any payment mode. The final tax invoice is issued at checkout."
        : "An interim statement for a continuing stay. No surcharge applies on any payment mode. The final tax invoice is issued at checkout and nets every payment received.",
    tariffVersion: "T1.0",
  });
  return { html, invoiceRef, hotel, figures: f, kind: req.kind, prelude: p };
}

/**
 * Desk inline preview (2026-08-01): the proforma document as HTML, composed fresh from the
 * invoice's CURRENT data (folio payments, advance requirement, accepted quote terms). No PDF
 * render, no storage write, no InvoiceLine snapshot, no trace — a pure read. The stored PDF
 * (when later rendered) runs the same composition.
 */
export async function renderInvoicePreviewHtml(
  prisma: PrismaClient,
  invoiceId: string,
): Promise<{ html: string; invoiceRef: string }> {
  const inv = await loadInvoiceForRender(prisma, invoiceId);
  if (inv.invoiceType === InvoiceType.INTERIM) {
    const m = await buildInterimDocRender(prisma, inv);
    return { html: m.html, invoiceRef: m.invoiceRef };
  }
  if (inv.invoiceType !== InvoiceType.PROFORMA) {
    throw new ValidationError("Inline preview is available for proforma and interim invoices only");
  }
  const m = await buildProformaDocRender(prisma, inv);
  return { html: m.html, invoiceRef: m.invoiceRef };
}

/**
 * Freeze every live, never-rendered proforma for an entry by rendering its PDF NOW —
 * called just BEFORE something supersedes them (advance-requirement change, re-entry).
 *
 * Why (2026-08-02, operator ruling): a superseded proforma without a stored artifact can
 * only be shown by RECOMPOSING from current data, so every later requirement change
 * rewrote what old versions displayed. Rendering the artifact at supersession time freezes
 * the figures that were actually on the table when that version was live; the desk's
 * frozen-PDF view then serves it unchanged forever (write-once storage).
 *
 * Best-effort per invoice: a render failure falls back to the existing caveat-labelled
 * reconstruction rather than blocking the operation that triggered the supersession.
 */
export async function freezeUnrenderedProformasForEntry(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
): Promise<void> {
  const live = await prisma.invoice.findMany({
    where: {
      entryId,
      invoiceType: InvoiceType.PROFORMA,
      state: { not: "SUPERSEDED" },
      pdfStorageKey: null,
    },
    select: { id: true },
  });
  for (const inv of live) {
    try {
      await generateOrLoadInvoicePdf(prisma, inv.id, actorId);
    } catch {
      /* degrade to the caveat-labelled reconstruction for this one */
    }
  }
}

/**
 * What `buildFinalInvoiceFigures` reads (2026-08-22): the invoice's bucket and its folio's lines +
 * payments. Structural, so the in-stay DRAFT tax invoice — which has no Invoice row — can be
 * built from the folio alone (`{ billingModel: null, folio }`).
 */
export type FinalInvoiceFiguresSource = {
  billingModel: string | null;
  folio: { billingModel: string | null; lines: LedgerLineLike[]; payments: LedgerPaymentLike[] } | null;
};

export type FinalInvoiceComponent = {
  key: LedgerComponentKey;
  label: string;
  base: number;
  serviceCharge: number;
  gst: number;
  /** All-in (base + SC + GST). */
  total: number;
  chargeCount: number;
  roomNights: number;
  roomNumbers: string[];
  descriptions: string[];
};

/** The FINAL / Tax Invoice figures, all read from the ledger. */
export type FinalInvoiceFigures = {
  roomLines: Array<{
    particular: string;
    roomNo: string;
    nights: number;
    rate: number;
    amount: number;
    folioLineId: string | null;
  }>;
  /** Σ charge lines (net) — room, F&B, service, other, credit notes. */
  subtotal: number;
  discountAmount: number;
  /** Σ service-charge companion lines on the ledger (+ render-time SC for legacy room lines). */
  serviceCharge: number;
  /** Σ GST companion lines on the ledger (+ render-time GST for legacy room lines). */
  gstAmount: number;
  /** = the folio's billed-so-far for the covered lines. */
  totalBeforeAdvance: number;
  /** Payments IN − OUT covered by this invoice (advance + settlement, net of refunds). */
  advanceAmount: number;
  focAmount: number;
  /** = totalBeforeAdvance − advanceAmount, i.e. the folio's outstanding balance for the covered lines. */
  totalPayable: number;
  /** Per-component all-in buckets (2026-08-22) — the Master Bill's rollup rows and the tax
   *  invoice's category-level lines. Only components with at least one charge line. */
  components: FinalInvoiceComponent[];
  /** The downward ladder, additive from the ledger: net → service → taxable → GST → total. */
  ladder: { net: number; serviceCharge: number; taxable: number; gst: number; total: number };
  /** The payment records the figures net (bucket-filtered), oldest first. */
  payments: Array<{ id: string; amount: number; direction: string; method: string | null; receivedAt: Date | null }>;
};

/**
 * Compose the FINAL invoice's money figures from the loaded invoice + folio. PURE — no I/O,
 * no rounding drift between callers: `generateOrLoadInvoicePdf` renders exactly these, and
 * the S8/S9 final-invoice email (s9-service) prints exactly these.
 */
export function buildFinalInvoiceFigures(
  inv: FinalInvoiceFiguresSource,
  opts: { gstRate: number; svcRate: number; nights: number; nightlyRate: number },
): FinalInvoiceFigures {
  const { gstRate, svcRate, nights, nightlyRate } = opts;
  // Which folio lines this invoice covers (2026-08-18 — the invoice is a VIEW OF THE LEDGER):
  //   - Split-billing filter: only lines whose billingModel matches this invoice's bucket.
  //     For legacy whole-folio invoices (invoice.billingModel = null) every line passes.
  //     NULL-billingModel lines (pre-Phase-1 backfill data) roll up to the folio's primary
  //     model, matching the ledger's rule in `computeOutstandingForBillingModel`.
  //   - NO line-type filter. Every charge line prints, the tax rows are the ledger's own SC/GST
  //     companion lines, and the invoice total equals the folio's billed-so-far to the paisa.
  // Since 2026-08-22 that reading is the shared ledger view (lib/folio-ledger-view.ts) — the
  // Master Bill and the Interim Folio Statement read the identical view, so the three documents
  // cannot disagree about a single line.
  const isBucketScoped = !!inv.billingModel;
  const view = buildFolioLedgerView({
    lines: inv.folio?.lines ?? [],
    payments: inv.folio?.payments ?? [],
    invoiceBucket: inv.billingModel ?? null,
    primaryModel: inv.folio?.billingModel ?? null,
    gstRate,
    svcRate,
  });

  type RoomLineDisplay = FinalInvoiceFigures["roomLines"][number];
  const roomLines: RoomLineDisplay[] = view.charges.map(({ line, isRoom }) => {
    // Particular label = "Room" for room lines (legacy visual), otherwise the folio line's
    // description so F&B / SERVICE / OTHER lines self-identify. A correction line's
    // description carries the corrected line's UUID ("Correction for <id>: reason") — print
    // it as "Correction: reason"; the snapshot keeps the folioLineId for the trail.
    const particular = isRoom ? "Room" : line.description.replace(/^Correction for \S+: /, "Correction: ");
    // Room number from the line's own room attribution; older lines fall back to the
    // "· Room 302" suffix of the audit description.
    const roomNo = line.room?.roomNumber ?? (line.description.match(/(?:^|[·\s])Room\s+([A-Za-z0-9-]+)\s*$/)?.[1] ?? "").trim();
    const amount = Number(toDecimal(line.amount).toFixed(2));
    return { particular, roomNo, nights: 1, rate: amount, amount, folioLineId: line.id };
  });

  // Legacy room lines with no tax on the ledger (audited before 2026-08-18, imported rows) have
  // their SC/GST computed at render — aggregated and rounded once (the view's rule).
  let legacyServiceCharge = view.legacyServiceCharge;
  let legacyGst = view.legacyGst;
  let synthesised = false;
  if (view.charges.length === 0 && !isBucketScoped) {
    // Legacy synthesise-from-quote fallback (only for whole-folio invoices with no charges yet
    // — a pre-checkout preview). Nothing on the ledger, so the room tax is computed at render.
    synthesised = true;
    let net = ZERO;
    for (let i = 0; i < nights; i++) {
      roomLines.push({ particular: "Room", roomNo: "", nights: 1, rate: nightlyRate, amount: nightlyRate, folioLineId: null });
      net = net.add(toDecimal(nightlyRate));
    }
    const t = legacyTaxOn(net, svcRate, gstRate);
    legacyServiceCharge = t.serviceCharge;
    legacyGst = t.gst;
  }

  const subtotal = Number(sumMoney(roomLines.map((l) => l.amount)).toFixed(2));
  const discountAmount = 0;
  const scLedger = sumMoney(view.companions.filter((c) => c.kind === "SERVICE_CHARGE").map((c) => c.line.amount));
  const gstLedger = sumMoney(view.companions.filter((c) => c.kind === "GST").map((c) => c.line.amount));
  const serviceCharge = Number(scLedger.add(legacyServiceCharge).toFixed(2));
  const gstAmount = Number(gstLedger.add(legacyGst).toFixed(2));
  const totalBeforeAdvance = Number((subtotal - discountAmount + serviceCharge + gstAmount).toFixed(2));

  // Payment attribution — everything the guest has paid so far (advance + settlement), net of
  // refunds, so "Total payable" is the folio's own outstanding balance. Bucket-filtered by the
  // view (NULL-model payments roll up to the primary bucket, mirroring the ledger).
  const advanceAmount = Number(view.payments.net.toFixed(2));
  const focAmount = 0;
  const totalPayable = Number((totalBeforeAdvance - advanceAmount - focAmount).toFixed(2));

  const n2 = (d: { toFixed(n: number): string }) => Number(d.toFixed(2));
  const components: FinalInvoiceComponent[] = synthesised
    ? [
        {
          key: "ROOM",
          label: "Room",
          base: subtotal,
          serviceCharge,
          gst: gstAmount,
          total: totalBeforeAdvance,
          chargeCount: roomLines.length,
          roomNights: nights,
          roomNumbers: [],
          descriptions: [],
        },
      ]
    : LEDGER_COMPONENTS.map(({ key }) => {
        const b = view.components[key];
        return {
          key,
          label: b.label,
          base: n2(b.base),
          serviceCharge: n2(b.serviceCharge),
          gst: n2(b.gst),
          total: n2(b.total),
          chargeCount: b.chargeCount,
          roomNights: b.roomNights,
          roomNumbers: b.roomNumbers,
          descriptions: b.descriptions,
        };
      }).filter((c) => c.chargeCount > 0);

  return {
    roomLines,
    subtotal,
    discountAmount,
    serviceCharge,
    gstAmount,
    totalBeforeAdvance,
    advanceAmount,
    focAmount,
    totalPayable,
    components,
    ladder: {
      net: subtotal,
      serviceCharge,
      taxable: Number((subtotal + serviceCharge).toFixed(2)),
      gst: gstAmount,
      total: totalBeforeAdvance,
    },
    payments: [...view.payments.records]
      .sort((a, b) => (a.receivedAt ?? a.createdAt).getTime() - (b.receivedAt ?? b.createdAt).getTime())
      .map((p) => ({
        id: p.id,
        amount: Number(toDecimal(p.amount).toFixed(2)),
        direction: p.paymentDirection,
        method: p.paymentMethod ?? null,
        receivedAt: p.receivedAt ?? null,
      })),
  };
}

// =============================================================================================
// B1 · Tax Invoice composition (2026-08-22) — shared by the issued FINAL invoice's PDF and the
// in-stay DRAFT the desk previews at S7/S8. One composition, two states: DRAFT (no serial,
// watermark, loud "not issued" strip) and ISSUED ("original" in the footline).
// =============================================================================================

export type TaxInvoiceParties = {
  billedTo: string;
  forGuest: string | null;
  customerTpn: string | null;
  yourRef: string | null;
};

/**
 * Who the tax invoice is billed to — the corporate preset (D-13) when a corporate account books
 * (its TPN + the client's own reference), the agency when an agent books (guest named beneath),
 * else the guest. Shared by the issued document and the draft so the two name the same payer.
 */
export function taxInvoicePartiesFromEntry(entry: {
  guestProfile: { firstName: string | null; lastName: string | null } | null;
  contactPersonName: string | null;
  inquiry: {
    travelAgent: { displayName: string } | null;
    corporateAccount: { displayName: string; gstNumber: string | null } | null;
    corporateClientRef: string | null;
  } | null;
}): TaxInvoiceParties {
  const guestName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ").trim() ||
    entry.contactPersonName?.trim() ||
    "Guest";
  const corporate = entry.inquiry?.corporateAccount ?? null;
  const agent = entry.inquiry?.travelAgent ?? null;
  if (corporate) {
    return {
      billedTo: corporate.displayName,
      forGuest: guestName,
      customerTpn: corporate.gstNumber?.trim() || null,
      yourRef: entry.inquiry?.corporateClientRef?.trim() || null,
    };
  }
  if (agent) return { billedTo: agent.displayName, forGuest: guestName, customerTpn: null, yourRef: null };
  return { billedTo: guestName, forGuest: null, customerTpn: null, yourRef: null };
}

export type TaxInvoiceRenderInput = {
  hotel: HotelProfileForRender;
  figures: FinalInvoiceFigures;
  parties: TaxInvoiceParties;
  bookingRef: string;
  stay: { checkIn: Date | null; checkOut: Date | null; nights: number | null };
  /** Room numbers to print (falls back to the ledger's attribution when empty). */
  roomNumbers?: string[];
  /** The issued original's reference + date. Null renders the DRAFT. */
  issued: { invoiceRef: string; issuedAt: Date } | null;
  /** The instant the figures were read — the draft's "Position as at". */
  asAt: Date;
  /** Configured rates — used for the labels only when the ledger carries no tax to derive them from. */
  gstRate: number;
  svcRate: number;
  copy?: boolean;
};

/**
 * "10" / "5" / "12.5" — the rate a ledger actually charged, read off its own figures so an old
 * folio is labelled with the rate it was taxed at, never today's. Σ companions ÷ Σ net drifts a
 * few hundredths from the true rate through per-line 2dp rounding ("10.02%"), so the derived
 * figure snaps to the configured rate when it is within rounding of it; a genuinely different
 * rate (a folio taxed while GST was 0, a rate change mid-history) prints as itself, 1dp.
 */
function ratePercentLabel(part: number, base: number, fallbackRate: number): string {
  const configured = fallbackRate * 100;
  if (!(base > 0)) return String(Math.round(configured * 100) / 100);
  const pct = (part / base) * 100;
  if (!Number.isFinite(pct)) return String(Math.round(configured * 100) / 100);
  if (Math.abs(pct - configured) < 0.3) return String(Math.round(configured * 100) / 100);
  return String(Math.round(pct * 10) / 10);
}

function describeComponent(c: FinalInvoiceComponent): string {
  if (c.key === "ROOM") return `Accommodation · ${c.roomNights} room-night${c.roomNights === 1 ? "" : "s"}`;
  const digest = c.descriptions
    .slice(0, 3)
    .map((d) => (d.length > 28 ? `${d.slice(0, 27)}…` : d))
    .join(" · ");
  const more = c.descriptions.length > 3 ? ` +${c.descriptions.length - 3} more` : "";
  return digest ? `${c.label} · ${digest}${more}` : `${c.label} · ${c.chargeCount} item${c.chargeCount === 1 ? "" : "s"}`;
}

export function composeTaxInvoiceHtml(input: TaxInvoiceRenderInput): string {
  const { figures: f, hotel } = input;
  const draft = input.issued == null;
  const roomNumbers =
    input.roomNumbers && input.roomNumbers.length > 0
      ? input.roomNumbers
      : (f.components.find((c) => c.key === "ROOM")?.roomNumbers ?? []);
  const scPct = ratePercentLabel(f.ladder.serviceCharge, f.ladder.net, input.svcRate);
  const gstPct = ratePercentLabel(f.ladder.gst, f.ladder.taxable, input.gstRate);

  const settlementLines: Array<{ label: string; value: string }> = [];
  const ins = f.payments.filter((p) => p.direction === "IN");
  const outs = f.payments.filter((p) => p.direction === "OUT");
  if (ins.length > 4) {
    settlementLines.push({
      label: `Advance / payments applied (${ins.length} receipts)`,
      value: `−${formatMoney(ins.reduce((s, p) => s + p.amount, 0))}`,
    });
  } else {
    for (const p of ins) settlementLines.push({ label: `Advance / payment applied · ${p.id}`, value: `−${formatMoney(p.amount)}` });
  }
  for (const p of outs) settlementLines.push({ label: `Refunded · ${p.id}`, value: `+${formatMoney(p.amount)}` });

  const balance = f.totalPayable;
  // A negative figure on the ISSUED original is money to return; on an in-stay DRAFT it is the
  // guest paid ahead of nights the audit has not posted yet (an interim or extension payment),
  // which is not a refund and must not read as one.
  const balanceLabel =
    balance > 0 ? "Balance due" : balance < 0 ? (draft ? "Paid ahead of charges still to post" : "Refund due to guest") : "Paid in full";
  const reference = input.issued?.invoiceRef ?? input.bookingRef;

  return renderLegphelTaxInvoiceHtml({
    masthead: mastheadFromHotelProfile(hotel),
    invoiceNo: input.issued?.invoiceRef ?? null,
    draft,
    draftStrip: draft ? `Draft — not issued · indicative position as at ${formatDocDateTimeLocal(input.asAt)}` : null,
    bookingRef: input.bookingRef,
    issued: draft ? formatDocDateTimeLocal(input.asAt) : formatDocDate(input.issued!.issuedAt),
    billedTo: input.parties.billedTo,
    forGuest: input.parties.forGuest,
    customerTpn: input.parties.customerTpn,
    yourRef: input.parties.yourRef,
    stay:
      input.stay.checkIn && input.stay.checkOut ? formatStayRange(input.stay.checkIn, input.stay.checkOut, input.stay.nights) : null,
    rooms: roomNumbers.length > 0 ? `Room${roomNumbers.length === 1 ? "" : "s"} ${roomNumbers.join(", ")}` : null,
    lines: f.components.map((c) => ({ description: describeComponent(c), amount: formatMoney(c.total) })),
    detailNote: "Itemised detail on the Master Bill.",
    netValue: formatMoney(f.ladder.net),
    serviceChargeLabel: `Service charge ${scPct}%`,
    serviceCharge: formatMoney(f.ladder.serviceCharge),
    taxableValue: formatMoney(f.ladder.taxable),
    gstLabel: `GST @ ${gstPct}%`,
    gst: formatMoney(f.ladder.gst),
    total: formatMoney(f.ladder.total),
    settlementLines,
    balanceLabel,
    balanceDue: formatMoney(Math.abs(balance)),
    gstSentence: `GST of Nu. ${formatMoney(f.ladder.gst)} is included in the total consideration of Nu. ${formatMoney(f.ladder.total)}.`,
    bank:
      balance > 0
        ? {
            bankName: null,
            accountName: hotel.accountNumber ? `${hotel.hotelName} · ${hotel.accountNumber}` : null,
            reference,
            accountsPhone: primaryContactNumber(hotel.contactNumbers) || null,
          }
        : null,
    closingNote: draft
      ? "Draft for checking the particulars before issue — the tax invoice is issued at checkout settlement and carries its serial from then. Not a demand for payment: the interim folio statement is the in-stay handout."
      : "Please raise any discrepancy within 7 days. No surcharge applies on any payment mode; remitter bears transfer charges — the full invoice value must be received.",
    tariffVersion: "T1.0",
    pageLabel: draft ? "Page 1 of 1 · draft" : input.copy ? "Page 1 of 1 · COPY" : "Page 1 of 1 · original",
    copy: input.copy,
  });
}

export async function generateOrLoadInvoicePdf(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
): Promise<InvoicePdfArtifact> {
  const inv = await loadInvoiceForRender(prisma, invoiceId);

  // Idempotency — write-once means the stored file wins.
  if (inv.pdfStorageKey && inv.pdfChecksum) {
    const bytes = await readDocument(inv.pdfStorageKey);
    return {
      storageKey: inv.pdfStorageKey,
      checksum: inv.pdfChecksum,
      bytes,
      filename: filenameFor(inv.invoiceType, inv.invoiceNumber ?? inv.id),
    };
  }

  const invoiceRef = inv.invoiceNumber ?? inv.id;
  const now = new Date();

  // ================================================================
  // INTERIM branch (2026-08-21) — the figures frozen on the request.
  // ================================================================
  if (inv.invoiceType === InvoiceType.INTERIM) {
    const m = await buildInterimDocRender(prisma, inv);
    const bytes = await renderHtmlToPdf(m.html, { fitToPage: true });
    const checksum = hashSha256(bytes);
    const storageKey = buildStorageKey("interim-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
    await writeDocument(storageKey, bytes);
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          pdfStorageKey: storageKey,
          pdfChecksum: checksum,
          pdfChecksumAlgo: "SHA-256",
          pdfRenderedAt: now,
          pdfRenderedBy: actorId,
          renderInputSnapshot: {
            documentTitle: m.kind === "EXTENSION" ? "INTERIM INVOICE — STAY EXTENSION" : "INTERIM INVOICE",
            invoiceRef,
            versionNumber: inv.versionNumber,
            kind: m.kind,
            figures: m.figures,
            primaryGuestName: m.prelude.guestName,
            hotel: {
              hotelName: m.hotel.hotelName,
              registeredAddress: m.hotel.registeredAddress,
              primaryEmail: m.hotel.primaryEmail,
              accountNumber: m.hotel.accountNumber,
              tpnNumber: m.hotel.tpnNumber,
              gstTpnNumber: m.hotel.gstTpnNumber,
            },
          } as any,
        },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "INVOICE.PDF_GENERATED",
          actorId,
          actorLevel: "SYSTEM",
          entityType: "Invoice",
          entityId: inv.id,
          operation: "CREATE",
          timestamp: now,
          entryId: inv.entryId,
          payload: { invoiceId: inv.id, invoiceType: inv.invoiceType, invoiceRef, storageKey, checksum, checksumAlgo: "SHA-256", byteLength: bytes.byteLength },
          createdBy: actorId,
        } as any,
      });
    });
    return { storageKey, checksum, bytes, filename: filenameFor(inv.invoiceType, invoiceRef) };
  }

  // ================================================================
  // PROFORMA branch — same template as quotation.
  // ================================================================
  if (inv.invoiceType === InvoiceType.PROFORMA) {
    const m = await buildProformaDocRender(prisma, inv);

    const bytes = await renderHtmlToPdf(m.html, { fitToPage: true });
    const checksum = hashSha256(bytes);
    const storageKey = buildStorageKey("proforma-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
    await writeDocument(storageKey, bytes);

    await prisma.$transaction(async (tx) => {
      const lineData: Prisma.InvoiceLineCreateManyInput[] = m.linesForTemplate.map((l, i) => ({
        invoiceId: inv.id,
        lineNumber: i + 1,
        particular: "Room",
        // Per-room path stamps the room number; legacy per-night rows leave it null.
        roomNo: l.roomNo ?? null,
        nights: 1,
        rate: new Prisma.Decimal(Number(l.amount).toFixed(2)),
        amount: new Prisma.Decimal(Number(l.amount).toFixed(2)),
        currency: "BTN",
      }));
      await tx.invoiceLine.deleteMany({ where: { invoiceId: inv.id } });
      if (lineData.length > 0) await tx.invoiceLine.createMany({ data: lineData });

      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          pdfStorageKey: storageKey,
          pdfChecksum: checksum,
          pdfChecksumAlgo: "SHA-256",
          pdfRenderedAt: now,
          pdfRenderedBy: actorId,
          renderInputSnapshot: {
            documentTitle: "PROFORMA INVOICE",
            invoiceRef,
            versionNumber: inv.versionNumber,
            checkIn: m.prelude.checkIn.toISOString(),
            checkOut: m.prelude.checkOut.toISOString(),
            nights: m.prelude.nights,
            roomCount: m.prelude.roomCount,
            nightlyRate: m.prelude.nightlyRate,
            perNightAmount: m.perNightAmount,
            totalAmount: m.totalAmount,
            advanceAmount: m.advanceReceived,
            requiredAdvance: m.requiredAdvance,
            advanceDueNow: m.advanceDueNow,
            focAmount: 0,
            totalPayable: m.totalPayable,
            primaryGuestName: m.prelude.guestName,
            occupantsString: m.prelude.occupantsString,
            mealPlanDisplay: m.prelude.mealPlanDisplay,
            extraBeds: m.prelude.extraBeds,
            hotel: {
              hotelName: m.hotel.hotelName,
              registeredAddress: m.hotel.registeredAddress,
              primaryEmail: m.hotel.primaryEmail,
              accountNumber: m.hotel.accountNumber,
              tpnNumber: m.hotel.tpnNumber,
              gstTpnNumber: m.hotel.gstTpnNumber,
            },
          } as any,
        },
      });

      await tx.traceEvent.create({
        data: {
          eventType: "INVOICE.PDF_GENERATED",
          actorId,
          actorLevel: "SYSTEM",
          entityType: "Invoice",
          entityId: inv.id,
          operation: "CREATE",
          timestamp: now,
          entryId: inv.entryId,
          payload: {
            invoiceId: inv.id,
            invoiceType: inv.invoiceType,
            invoiceRef,
            storageKey,
            checksum,
            checksumAlgo: "SHA-256",
            byteLength: bytes.byteLength,
          },
          createdBy: actorId,
        } as any,
      });
    });

    return {
      storageKey,
      checksum,
      bytes,
      filename: filenameFor(inv.invoiceType, invoiceRef),
    };
  }

  // ================================================================
  // FINAL branch — the B1 Tax Invoice (house format since 2026-08-22).
  //
  // Split-billing (Phase 3, 2026-07-25): when `inv.billingModel` is populated, the invoice
  // covers ONLY folio lines whose `billingModel` matches — so an agent-DIRECT_BILL invoice
  // shows just the agent's charges, a guest-GUEST_PAY invoice shows just guest charges.
  // ================================================================
  const hotel = await loadHotelProfileForRender(prisma);
  const { nights, nightlyRate, guest, guestName, checkIn, checkOut } = invoicePrelude(inv);
  // Same resolver as quotes and charge posting (2026-08-03) — the prior
  // `requireActiveConfigValue(...) || 0.05` threw when the key was unseeded and silently
  // overrode a configured 0, so invoices could print rates the folio never charged.
  const { gstRate, serviceChargeRate: svcRate } = await resolveChargeRates(prisma);

  // Every money figure on the FINAL invoice comes from the ledger through the shared pure
  // builder — the S8/S9 final-invoice EMAIL reads the same figures, so the PDF, the email and
  // the desk's bill can never disagree.
  const fig = buildFinalInvoiceFigures(inv, { gstRate, svcRate, nights, nightlyRate });
  const { roomLines, subtotal, discountAmount, serviceCharge, gstAmount, totalBeforeAdvance, advanceAmount, focAmount, totalPayable } = fig;

  // The payer (corporate preset with TPN + their reference / agency / guest) and the contact
  // person are kept on the snapshot; the face prints the B1 zones only.
  const travelAgentName = inv.entry.inquiry?.travelAgent?.displayName
    ?? inv.entry.inquiry?.corporateAccount?.displayName
    ?? "Walk-In";
  const displayGuestName = inv.entry.contactPersonName?.trim() || guestName;
  const contactNo = inv.entry.contactPersonPhone?.trim() || guest?.phone || "";
  const guestEmail = guest?.email ?? inv.dispatchedTo ?? "";
  const preparedByName = await getPreparedByName(prisma, actorId);
  const parties = taxInvoicePartiesFromEntry(inv.entry);

  const html = composeTaxInvoiceHtml({
    hotel,
    figures: fig,
    parties,
    bookingRef: inv.entryId,
    stay: { checkIn, checkOut, nights },
    issued: { invoiceRef, issuedAt: inv.issuedAt ?? inv.dispatchedAt ?? now },
    asAt: now,
    gstRate,
    svcRate,
  });

  const bytes = await renderHtmlToPdf(html, { fitToPage: true });
  const checksum = hashSha256(bytes);
  const storageKey = buildStorageKey("tax-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
  await writeDocument(storageKey, bytes);

  await prisma.$transaction(async (tx) => {
    const lineData: Prisma.InvoiceLineCreateManyInput[] = roomLines.map((l, i) => ({
      invoiceId: inv.id,
      lineNumber: i + 1,
      particular: l.particular,
      roomNo: l.roomNo || null,
      nights: l.nights,
      rate: new Prisma.Decimal(l.rate.toFixed(2)),
      amount: new Prisma.Decimal(l.amount.toFixed(2)),
      serviceChargeAmount: new Prisma.Decimal(serviceCharge.toFixed(2)),
      gstAmount: new Prisma.Decimal(gstAmount.toFixed(2)),
      currency: "BTN",
      folioLineId: l.folioLineId,
    }));
    await tx.invoiceLine.deleteMany({ where: { invoiceId: inv.id } });
    if (lineData.length > 0) await tx.invoiceLine.createMany({ data: lineData });

    await tx.invoice.update({
      where: { id: inv.id },
      data: {
        pdfStorageKey: storageKey,
        pdfChecksum: checksum,
        pdfChecksumAlgo: "SHA-256",
        pdfRenderedAt: now,
        pdfRenderedBy: actorId,
        renderInputSnapshot: {
          documentTitle: "TAX INVOICE",
          templateFamily: "legphel-house-B1",
          invoiceRef,
          versionNumber: inv.versionNumber,
          billedTo: parties.billedTo,
          customerTpn: parties.customerTpn,
          yourRef: parties.yourRef,
          components: fig.components,
          ladder: fig.ladder,
          payments: fig.payments,
          travelAgentName,
          guestName: displayGuestName,
          contactNo,
          guestEmail,
          checkIn: checkIn.toISOString(),
          checkOut: checkOut.toISOString(),
          nights,
          roomLines,
          subtotal,
          discountAmount,
          serviceChargeRatePercent: Math.round(svcRate * 100),
          serviceCharge,
          gstRatePercent: Math.round(gstRate * 100),
          gstAmount,
          totalBeforeAdvance,
          advanceAmount,
          focAmount,
          totalPayable,
          preparedByName,
          hotel: {
            hotelName: hotel.hotelName,
            registeredAddress: hotel.registeredAddress,
            primaryEmail: hotel.primaryEmail,
            accountNumber: hotel.accountNumber,
            tpnNumber: hotel.tpnNumber,
            gstTpnNumber: hotel.gstTpnNumber,
          },
        } as any,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "INVOICE.PDF_GENERATED",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Invoice",
        entityId: inv.id,
        operation: "CREATE",
        timestamp: now,
        entryId: inv.entryId,
        payload: {
          invoiceId: inv.id,
          invoiceType: inv.invoiceType,
          invoiceRef,
          storageKey,
          checksum,
          checksumAlgo: "SHA-256",
          byteLength: bytes.byteLength,
        },
        createdBy: actorId,
      } as any,
    });
  });

  return {
    storageKey,
    checksum,
    bytes,
    filename: filenameFor(inv.invoiceType, invoiceRef),
  };
}
