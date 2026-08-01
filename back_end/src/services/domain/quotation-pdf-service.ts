/**
 * S2 Quotation PDF generation.
 *
 * Called from `sendQuotation` (right BEFORE the outbound email is dispatched) so the PDF
 * exists in storage and its bytes can be attached. Pattern:
 *
 *   1. Load the quotation, entry, guest, agent (if any), and its commercialTerms breakdown.
 *   2. Snapshot each priced night into a QuotationLine row.
 *   3. Render HTML via the shared template → PDF via Puppeteer.
 *   4. Compute SHA-256, write to storage under `documents/YYYY/MM/quotation/QUO-…-Vn.pdf`,
 *      record storageKey + checksum + rendered-at + input snapshot on the Quotation row.
 *   5. Emit `QUOTATION.PDF_GENERATED` trace with the checksum.
 *   6. Return `{ storageKey, checksum, bytes }` for the email attachment.
 *
 * Idempotency: if the quotation already has a `pdfStorageKey`, we don't re-render — we read
 * the stored file and return it. This matches the invoice-immutability principle: what the
 * guest received is what stays. Corrections use a new quotation version.
 *
 * The document COMPOSITION (terms → A1 house-format HTML) is factored into
 * `buildQuotationDocRender` so the desk's inline preview (`renderQuotationPreviewHtml`,
 * 2026-08-01) shows the exact same document WITHOUT rendering a PDF, writing storage, or
 * snapshotting QuotationLine rows — pure read, always from the quotation's current terms.
 */
import { Prisma, type PrismaClient, type QuotationLine } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { buildStorageKey, hashSha256, readDocument, writeDocument } from "../../lib/document-storage.js";
import { formatMoney, loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderLegphelQuotationHtml } from "../infrastructure/pdf-templates/legphel-quotation-template.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatStayRange } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";

type QuotationTerms = {
  roomCount?: number;
  effectiveRate?: string | number;
  currency?: string;
  roomTypeId?: string;
  pricingBreakdown?: { nightlyRate?: number | string; nights?: number; roomCount?: number; subTotal?: number | string };
  mealPlan?: string;
  extraBeds?: string | number;
  perGuestMealBreakdown?: { total?: number | string };
} | null;

export type QuotationPdfArtifact = {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
  invoiceNumber: string;
};

type LoadedQuotation = Prisma.QuotationGetPayload<{
  include: {
    entry: {
      include: {
        guestProfile: true;
        inquiry: { include: { travelAgent: true; corporateAccount: true } };
      };
    };
  };
}>;

async function loadQuotationForRender(prisma: PrismaClient, quotationId: string): Promise<LoadedQuotation> {
  const q = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: {
      entry: {
        include: {
          guestProfile: true,
          inquiry: { include: { travelAgent: true, corporateAccount: true } },
        },
      },
    },
  });
  if (!q) throw new NotFoundError("Quotation");
  return q;
}

/** Intermediate print row — collapsed into the A1 table's four columns at render time. */
type PrintLine = {
  date: Date;
  roomNo?: string | null;
  roomTypeName?: string | null;
  occupants: string;
  mealPlan: string | null;
  extraBeds: string | null;
  amount: string | number;
};

/** Everything the PDF path persists plus the composed HTML — shared with the preview path. */
type QuotationDocRender = {
  html: string;
  linesForTemplate: PrintLine[];
  nights: number;
  roomCount: number;
  nightlyRate: number;
  perNightAmount: number;
  totalAmount: number;
  advanceAmount: number;
  focAmount: number;
  totalPayable: number;
  guestName: string;
  occupantsString: string;
  mealPlanDisplay: string;
  extraBeds: string;
  checkIn: Date;
  checkOut: Date;
  toEmail: string;
  fromName: string;
  documentDate: Date;
  hotel: Awaited<ReturnType<typeof loadHotelProfileForRender>>;
};

/**
 * Compose the A1 house-format quotation document from the quotation's CURRENT commercialTerms.
 * Pure read — no writes, no storage. Both the stored-PDF path and the desk's live preview run
 * through here, so the two can never disagree about what the quotation says.
 */
async function buildQuotationDocRender(prisma: PrismaClient, q: LoadedQuotation): Promise<QuotationDocRender> {
  const terms = (q.commercialTerms as QuotationTerms) ?? {};
  const nights = Math.max(1, Number(terms?.pricingBreakdown?.nights ?? 1));
  const roomCount = Math.max(1, Number(terms?.roomCount ?? terms?.pricingBreakdown?.roomCount ?? 1));
  const nightlyRate = Number(terms?.pricingBreakdown?.nightlyRate ?? terms?.effectiveRate ?? 0);

  // Build the printed booking table. One row per stay night per room count matches the
  // reference proforma exactly (each row shows Date | Occupants | Meal Plan | Extra Beds |
  // per-row tax-INCLUSIVE amount). If no dates are set, we emit at least one summary row.
  const guest = q.entry.guestProfile;
  const guestName = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ") || "Guest";
  const adultCount = q.entry.adultCount ?? Number(q.entry.guestCount ?? 1) ?? 1;
  const childCount = q.entry.childCount ?? 0;
  const occupantsString = `${adultCount} adult${adultCount === 1 ? "" : "s"}, ${childCount} child${childCount === 1 ? "" : "ren"}`;
  const mealPlanCode = String(terms?.mealPlan ?? "").trim();
  const mealPlanDisplay = mealPlanCode ? `${adultCount + childCount} ${mealPlanCode}` : "";
  const extraBeds = terms?.extraBeds != null && String(terms.extraBeds).trim() && String(terms.extraBeds) !== "0" ? String(terms.extraBeds) : "None";

  const checkIn = q.entry.checkInDate ?? new Date();
  const checkOut = q.entry.checkOutDate ?? new Date(checkIn.getTime() + nights * 86_400_000);

  // Per-row Amount (Nu.) is tax-INCLUSIVE per boss's convention on quotations / proforma:
  // = base × roomCount + 10% service charge + 5% GST on (base + service charge).
  // Uses `computeStayCharges` (Decimal-safe) with nights=1 to get the per-night tax-inclusive
  // total for the full room count. The bottom-of-page Total Amount = per-row total × nights.
  const perNightBreakdown = await computeStayCharges(prisma, nightlyRate, 1, roomCount);
  const perNightAmount = perNightBreakdown.total;

  // Per-room composition path (Phase D of per-room track, 2026-07-27). When the quotation
  // was built via the composition flow (Phase B), commercialTerms carries
  // `compositionTotals.perRoom[]` — one entry per room with its own tax-inclusive total.
  // We render one PDF row per room. Falls back to the legacy per-night rendering when no
  // composition is present.
  const compositionPerRoom = (terms as unknown as {
    compositionTotals?: {
      perRoom?: Array<{
        roomId: string;
        roomNumber: string | null;
        nights: number;
        effectiveBreakfastPax: number;
        effectiveLunchPax: number;
        effectiveDinnerPax: number;
        total: number;
      }>;
      total?: number;
    };
    roomCompositions?: Array<{
      roomId: string;
      adultCount?: number;
      cnb6To10Count?: number;
      cnbUnder6Count?: number;
      extraBedCount?: number;
      mealPlanCpCount?: number;
      mealPlanMaplCount?: number;
      mealPlanMapdCount?: number;
      mealPlanApCount?: number;
      mealPlanOthersCount?: number;
    }>;
  })?.compositionTotals?.perRoom;

  const linesForTemplate: PrintLine[] = [];
  let totalAmount = 0;
  // Room-type names for the description column — the reference A1 leads its description with
  // the type ("Deluxe · 1 room · 2 adults · MAP"), so resolve names for whichever rooms the
  // lines will mention (composition rooms, else the legacy sealed room type).
  if (Array.isArray(compositionPerRoom) && compositionPerRoom.length > 0) {
    const roomRows = await prisma.room.findMany({
      where: { id: { in: compositionPerRoom.map((r) => r.roomId) } },
      select: { id: true, roomType: { select: { name: true } } },
    });
    const typeNameByRoomId = new Map(roomRows.map((r) => [r.id, r.roomType?.name ?? null]));
    // One row per room summarising the whole stay for that room.
    const inputsByRoomId = new Map(
      ((terms as any).roomCompositions ?? []).map((r: any) => [r.roomId, r]),
    );
    for (const r of compositionPerRoom) {
      const raw = inputsByRoomId.get(r.roomId) as any;
      const adults = raw?.adultCount ?? 0;
      const cnb = (raw?.cnb6To10Count ?? 0) + (raw?.cnbUnder6Count ?? 0);
      const roomOccupants = `${adults} adult${adults === 1 ? "" : "s"}${cnb > 0 ? `, ${cnb} child${cnb === 1 ? "" : "ren"}` : ""}`;
      const planParts: string[] = [];
      if (raw?.mealPlanCpCount) planParts.push(`${raw.mealPlanCpCount} CP`);
      if (raw?.mealPlanMaplCount) planParts.push(`${raw.mealPlanMaplCount} MAP+L`);
      if (raw?.mealPlanMapdCount) planParts.push(`${raw.mealPlanMapdCount} MAP+D`);
      if (raw?.mealPlanApCount) planParts.push(`${raw.mealPlanApCount} AP`);
      if (raw?.mealPlanOthersCount) planParts.push(`${raw.mealPlanOthersCount} Others`);
      // EP is stated explicitly rather than leaving the meal slot blank — the guest reading
      // the quotation should see "room only" was a choice, not an omission.
      const planStr = planParts.length > 0 ? planParts.join(" · ") : "EP (room only)";
      const eb = raw?.extraBedCount && raw.extraBedCount > 0 ? `${raw.extraBedCount} extra bed${raw.extraBedCount === 1 ? "" : "s"}` : "None";
      linesForTemplate.push({
        date: checkIn,
        roomNo: r.roomNumber ?? r.roomId.slice(0, 6),
        roomTypeName: typeNameByRoomId.get(r.roomId) ?? null,
        occupants: roomOccupants,
        mealPlan: planStr,
        extraBeds: eb,
        amount: r.total,
      });
      totalAmount += Number(r.total);
    }
  } else {
    // Legacy: one row per stay night. Kept for backward compat.
    let legacyTypeName: string | null = null;
    if (terms?.roomTypeId) {
      const rt = await prisma.roomType.findUnique({ where: { id: terms.roomTypeId }, select: { name: true } });
      legacyTypeName = rt?.name ?? null;
    }
    for (let i = 0; i < nights; i++) {
      const date = new Date(checkIn.getTime() + i * 86_400_000);
      linesForTemplate.push({
        date,
        roomTypeName: legacyTypeName,
        occupants: occupantsString,
        mealPlan: mealPlanDisplay || null,
        extraBeds,
        amount: perNightAmount,
      });
    }
    totalAmount = perNightAmount * nights;
  }

  const advanceAmount = 0; // No advance recorded on S2 quotations
  const focAmount = 0;
  const totalPayable = totalAmount - advanceAmount - focAmount;

  const hotel = await loadHotelProfileForRender(prisma);
  const toEmail = guest?.email ?? q.sentTo ?? "";
  const fromName = hotel.hotelName;
  const documentDate = q.sentAt ?? new Date();

  // A1 Quotation, house format (docs/bills). Amounts here are TAX-INCLUSIVE; the Net / Service /
  // GST rows decompose that same total rather than adding to it, which is why the decomposition
  // is read from the priced terms instead of being recomputed.
  const ct =
    (terms as unknown as {
      compositionTotals?: {
        subtotal?: string | number;
        serviceCharge?: string | number;
        gst?: string | number;
        gstRate?: string | number;
        serviceChargeRate?: string | number;
      };
    })?.compositionTotals ?? null;
  const gstRate = Number(ct?.gstRate ?? 0);
  const scRate = Number(ct?.serviceChargeRate ?? 0);
  const netValue = ct ? Number(ct.subtotal ?? 0) : totalAmount;
  const serviceCharge = ct ? Number(ct.serviceCharge ?? 0) : 0;
  const gstValue = ct ? Number(ct.gst ?? 0) : 0;

  const html = renderLegphelQuotationHtml({
    masthead: mastheadFromHotelProfile(hotel),
    quotationNo: q.referenceNumber,
    bookingRef: q.entryId,
    date: formatDocDate(documentDate),
    validityStrip: q.validUntil
      ? `Valid until ${formatDocDate(q.validUntil)} · Not a booking confirmation`
      : "Not a booking confirmation",
    to: toEmail ? `${guestName} · ${toEmail}` : guestName,
    attn: null,
    stay: formatStayRange(checkIn, checkOut, nights),
    lines: linesForTemplate.map((l) => ({
      description: [
        l.roomTypeName,
        l.roomNo ? `Room ${l.roomNo}` : null,
        l.occupants,
        l.mealPlan,
        l.extraBeds && l.extraBeds !== "None" ? l.extraBeds : null,
      ]
        .filter(Boolean)
        .join(" · "),
      nights: String(nights),
      ratePerNight: formatMoney(Number(l.amount) / Math.max(1, nights)),
      amount: formatMoney(l.amount),
    })),
    netValue: formatMoney(netValue),
    serviceChargeLabel: scRate > 0 ? `Service charge ${(scRate * 100).toFixed(0)}%` : "Service charge",
    serviceCharge: formatMoney(serviceCharge),
    gstLabel: gstRate > 0 ? `GST @ ${(gstRate * 100).toFixed(0)}%` : "GST",
    gst: formatMoney(gstValue),
    total: formatMoney(totalAmount),
    closingNote:
      "Rates are inclusive of service charge and GST. Subject to availability at confirmation. " +
      "A proforma invoice with advance terms follows on acceptance.",
    tariffVersion: "T1.0",
  });

  return {
    html,
    linesForTemplate,
    nights,
    roomCount,
    nightlyRate,
    perNightAmount,
    totalAmount,
    advanceAmount,
    focAmount,
    totalPayable,
    guestName,
    occupantsString,
    mealPlanDisplay,
    extraBeds,
    checkIn,
    checkOut,
    toEmail,
    fromName,
    documentDate,
    hotel,
  };
}

/**
 * Desk inline preview (2026-08-01): the quotation document as HTML, composed fresh from the
 * quotation's CURRENT terms. No PDF render, no storage write, no QuotationLine snapshot, no
 * trace — a pure read the operator can call on a DRAFT to see the document before anything
 * is generated or sent. The stored PDF (when later rendered) runs the same composition.
 */
export async function renderQuotationPreviewHtml(
  prisma: PrismaClient,
  quotationId: string,
): Promise<{ html: string; referenceNumber: string }> {
  const q = await loadQuotationForRender(prisma, quotationId);
  const model = await buildQuotationDocRender(prisma, q);
  return { html: model.html, referenceNumber: q.referenceNumber };
}

export async function generateOrLoadQuotationPdf(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
): Promise<QuotationPdfArtifact> {
  const q = await loadQuotationForRender(prisma, quotationId);

  // === Idempotency: already rendered → serve the stored file. ===
  if (q.pdfStorageKey && q.pdfChecksum) {
    const bytes = await readDocument(q.pdfStorageKey);
    return {
      storageKey: q.pdfStorageKey,
      checksum: q.pdfChecksum,
      bytes,
      invoiceNumber: q.referenceNumber,
    };
  }

  const m = await buildQuotationDocRender(prisma, q);

  const bytes = await renderHtmlToPdf(m.html, { fitToPage: true });
  const checksum = hashSha256(bytes);
  const now = new Date();
  // Revision suffix so a re-render after a price change (operator previewed, then applied a
  // discount) lands on a NEW key instead of colliding with the write-once stored file.
  // Revision 1 keeps the legacy key shape so existing artifacts stay reachable.
  const revision = q.pdfRenderRevision ?? 1;
  const keyBase = revision > 1 ? `${q.referenceNumber}-v${q.versionNumber}-r${revision}` : `${q.referenceNumber}-v${q.versionNumber}`;
  const storageKey = buildStorageKey("quotation", keyBase, now);
  await writeDocument(storageKey, bytes);

  // Persist snapshot + artifact metadata + write QuotationLine rows atomically.
  await prisma.$transaction(async (tx) => {
    // QuotationLine snapshot — one row per booking-table row, immutable. Uses each line's
    // own amount so per-room composition rows carry their true tax-inclusive stay total,
    // not the legacy per-night value.
    const lineData: Prisma.QuotationLineCreateManyInput[] = m.linesForTemplate.map((l, i) => ({
      quotationId: q.id,
      lineNumber: i + 1,
      date: l.date,
      occupants: l.occupants,
      mealPlan: l.mealPlan,
      extraBeds: l.extraBeds,
      amount: new Prisma.Decimal(Number(l.amount).toFixed(2)),
      currency: "BTN",
    }));
    // deleteMany covers the rare case where a prior partial render left orphan rows.
    await tx.quotationLine.deleteMany({ where: { quotationId: q.id } });
    if (lineData.length > 0) await tx.quotationLine.createMany({ data: lineData });

    // Update quotation with artifact metadata + frozen input snapshot.
    await tx.quotation.update({
      where: { id: q.id },
      data: {
        pdfStorageKey: storageKey,
        pdfChecksum: checksum,
        pdfChecksumAlgo: "SHA-256",
        pdfRenderedAt: now,
        pdfRenderedBy: actorId,
        renderInputSnapshot: {
          documentTitle: "QUOTATION",
          referenceNumber: q.referenceNumber,
          versionNumber: q.versionNumber,
          toEmail: m.toEmail,
          fromName: m.fromName,
          documentDate: m.documentDate.toISOString(),
          checkIn: m.checkIn.toISOString(),
          checkOut: m.checkOut.toISOString(),
          nights: m.nights,
          roomCount: m.roomCount,
          nightlyRate: m.nightlyRate,
          perNightAmount: m.perNightAmount,
          totalAmount: m.totalAmount,
          advanceAmount: m.advanceAmount,
          focAmount: m.focAmount,
          totalPayable: m.totalPayable,
          primaryGuestName: m.guestName,
          occupantsString: m.occupantsString,
          mealPlanDisplay: m.mealPlanDisplay,
          extraBeds: m.extraBeds,
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
        eventType: "QUOTATION.PDF_GENERATED",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Quotation",
        entityId: q.id,
        operation: "CREATE",
        timestamp: now,
        entryId: q.entryId,
        payload: {
          quotationId: q.id,
          referenceNumber: q.referenceNumber,
          storageKey,
          checksum,
          checksumAlgo: "SHA-256",
          byteLength: bytes.byteLength,
        },
        createdBy: actorId,
      } as any,
    });
  });

  return { storageKey, checksum, bytes, invoiceNumber: q.referenceNumber };
}

/** Best-effort helper: return the QuotationLine snapshot for a quotation, or empty array. */
export async function loadQuotationLines(prisma: PrismaClient, quotationId: string): Promise<QuotationLine[]> {
  return prisma.quotationLine.findMany({ where: { quotationId }, orderBy: { lineNumber: "asc" } });
}
