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
 */
import { Prisma, type PrismaClient, type QuotationLine } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { buildStorageKey, hashSha256, readDocument, writeDocument } from "../../lib/document-storage.js";
import { loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderQuotationProformaHtml, type QuotationProformaLine } from "../infrastructure/pdf-templates/quotation-proforma-template.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";

type QuotationTerms = {
  roomCount?: number;
  effectiveRate?: string | number;
  currency?: string;
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

export async function generateOrLoadQuotationPdf(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
): Promise<QuotationPdfArtifact> {
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

  const linesForTemplate: QuotationProformaLine[] = [];
  for (let i = 0; i < nights; i++) {
    const date = new Date(checkIn.getTime() + i * 86_400_000);
    linesForTemplate.push({
      date,
      occupants: occupantsString,
      mealPlan: mealPlanDisplay || null,
      extraBeds,
      amount: perNightAmount,
    });
  }

  const totalAmount = perNightAmount * nights;
  const advanceAmount = 0; // No advance recorded on S2 quotations
  const focAmount = 0;
  const totalPayable = totalAmount - advanceAmount - focAmount;

  const hotel = await loadHotelProfileForRender(prisma);
  const toEmail = guest?.email ?? q.sentTo ?? "";
  const fromName = hotel.hotelName;
  const documentDate = q.sentAt ?? new Date();

  const html = renderQuotationProformaHtml({
    documentTitle: "QUOTATION",
    hotel,
    toEmail,
    fromName,
    invoiceNumber: q.referenceNumber,
    documentDate,
    checkIn,
    checkOut,
    numberOfNights: nights,
    primaryGuestName: guestName,
    lines: linesForTemplate,
    totalAmount,
    advanceAmount,
    focAmount,
    totalPayable,
    currency: "Nu.",
  });

  const bytes = await renderHtmlToPdf(html);
  const checksum = hashSha256(bytes);
  const now = new Date();
  const storageKey = buildStorageKey("quotation", `${q.referenceNumber}-v${q.versionNumber}`, now);
  await writeDocument(storageKey, bytes);

  // Persist snapshot + artifact metadata + write QuotationLine rows atomically.
  await prisma.$transaction(async (tx) => {
    // QuotationLine snapshot — one row per booking-table row, immutable.
    const lineData: Prisma.QuotationLineCreateManyInput[] = linesForTemplate.map((l, i) => ({
      quotationId: q.id,
      lineNumber: i + 1,
      date: l.date,
      occupants: l.occupants,
      mealPlan: l.mealPlan,
      extraBeds: l.extraBeds,
      amount: new Prisma.Decimal(perNightAmount.toFixed(2)),
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
          toEmail,
          fromName,
          documentDate: documentDate.toISOString(),
          checkIn: checkIn.toISOString(),
          checkOut: checkOut.toISOString(),
          nights,
          roomCount,
          nightlyRate,
          perNightAmount,
          totalAmount,
          advanceAmount,
          focAmount,
          totalPayable,
          primaryGuestName: guestName,
          occupantsString,
          mealPlanDisplay,
          extraBeds,
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
