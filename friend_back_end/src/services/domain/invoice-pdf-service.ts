/**
 * Invoice PDF generation — S3 PROFORMA and S8 FINAL / ROOM invoice.
 *
 * The PROFORMA uses the same visual template as S2 Quotation with the title swapped to
 * "PROFORMA INVOICE" (per boss's instruction "one template serves both").
 *
 * The FINAL / ROOM invoice uses a distinct template (`room-invoice-template.ts`, added
 * in Phase 5) because the layout is fundamentally different — centred hotel address block,
 * PARTICULAR / ROOM NO / NIGHT(S) / RATE / AMOUNT columns, subtotal + service + GST +
 * total breakdown, and "Prepared by:" pulls the actor's fullName.
 *
 * Both share:
 *   - Idempotent write-once storage (rendered once, served forever).
 *   - InvoiceLine snapshot.
 *   - renderInputSnapshot on the Invoice row for cold re-render decades later.
 *   - `INVOICE.PDF_GENERATED` trace event with the SHA-256 checksum.
 */
import { InvoiceType, Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { buildStorageKey, hashSha256, readDocument, writeDocument } from "../../lib/document-storage.js";
import {
  extractPrimaryPhone,
  getPreparedByName,
  loadHotelProfileForRender,
} from "../../lib/pdf-render-context.js";
import { toDecimal } from "../../lib/money.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import {
  renderQuotationProformaHtml,
  type QuotationProformaLine,
} from "../infrastructure/pdf-templates/quotation-proforma-template.js";
import { renderRoomInvoiceHtml } from "../infrastructure/pdf-templates/room-invoice-template.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";

type QuotationTerms = {
  roomCount?: number;
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

/** Kind key used for storage-path segmentation. */
function kindForInvoice(t: InvoiceType): "proforma-invoice" | "room-invoice" {
  return t === InvoiceType.PROFORMA ? "proforma-invoice" : "room-invoice";
}

/** Nice filename for downloads / email attachments. */
function filenameFor(invoiceType: InvoiceType, invoiceRef: string): string {
  const label = invoiceType === InvoiceType.PROFORMA ? "proforma" : "room-invoice";
  return `${invoiceRef}-${label}.pdf`;
}

export async function generateOrLoadInvoicePdf(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
): Promise<InvoicePdfArtifact> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      folio: { include: { lines: true, payments: true } },
      entry: {
        include: {
          guestProfile: true,
          reservation: true,
          inquiry: { include: { travelAgent: true, corporateAccount: true } },
          quotations: { where: { state: "ACCEPTED" }, orderBy: { versionNumber: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!inv) throw new NotFoundError("Invoice");

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

  const hotel = await loadHotelProfileForRender(prisma);
  const acceptedQ = inv.entry.quotations[0];
  const terms = (acceptedQ?.commercialTerms as QuotationTerms) ?? null;
  const nights = Math.max(1, Number(terms?.pricingBreakdown?.nights ?? 1));
  const roomCount = Math.max(
    1,
    Number(terms?.roomCount ?? terms?.pricingBreakdown?.roomCount ?? inv.entry.numberOfRooms ?? 1),
  );
  const nightlyRate = Number(terms?.pricingBreakdown?.nightlyRate ?? terms?.effectiveRate ?? 0);

  const guest = inv.entry.guestProfile;
  const guestName = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ") || "Guest";
  const adultCount = inv.entry.adultCount ?? Number(inv.entry.guestCount ?? 1) ?? 1;
  const childCount = inv.entry.childCount ?? 0;
  const occupantsString = `${adultCount} adult${adultCount === 1 ? "" : "s"}, ${childCount} child${childCount === 1 ? "" : "ren"}`;
  const mealPlanCode = String(terms?.mealPlan ?? "").trim();
  const mealPlanDisplay = mealPlanCode ? `${adultCount + childCount} ${mealPlanCode}` : "";
  const extraBeds = terms?.extraBeds != null && String(terms.extraBeds).trim() && String(terms.extraBeds) !== "0" ? String(terms.extraBeds) : "None";

  const checkIn = inv.entry.reservation?.frozenCheckInDate ?? inv.entry.checkInDate ?? new Date();
  const checkOut = inv.entry.reservation?.frozenCheckOutDate ?? inv.entry.checkOutDate ?? new Date(checkIn.getTime() + nights * 86_400_000);

  const invoiceRef = inv.invoiceNumber ?? inv.id;
  const now = new Date();

  // ================================================================
  // PROFORMA branch — same template as quotation.
  // ================================================================
  if (inv.invoiceType === InvoiceType.PROFORMA) {
    // Per-row Amount (Nu.) on Proforma is tax-INCLUSIVE — matches the Quotation convention.
    // `computeStayCharges` with nights=1 yields the per-night tax-inclusive total for the
    // full room count. Bottom-of-page Total Amount = per-row × nights.
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
    // Advance and FoC pulled from the folio's payments (IN) for a real total-payable calc.
    const inPayments = (inv.folio?.payments ?? []).filter((p) => p.paymentDirection === "IN");
    const advanceAmount = inPayments.reduce((s, p) => s + Number(toDecimal(p.amount).toFixed(2)), 0);
    const focAmount = 0;
    const totalPayable = totalAmount - advanceAmount - focAmount;

    const html = renderQuotationProformaHtml({
      documentTitle: "PROFORMA INVOICE",
      hotel,
      toEmail: guest?.email ?? inv.dispatchedTo ?? "",
      fromName: hotel.hotelName,
      invoiceNumber: invoiceRef,
      documentDate: inv.dispatchedAt ?? inv.issuedAt ?? now,
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
    const storageKey = buildStorageKey("proforma-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
    await writeDocument(storageKey, bytes);

    await prisma.$transaction(async (tx) => {
      const lineData: Prisma.InvoiceLineCreateManyInput[] = linesForTemplate.map((l, i) => ({
        invoiceId: inv.id,
        lineNumber: i + 1,
        particular: "Room",
        roomNo: null,
        nights: 1,
        rate: new Prisma.Decimal(perNightAmount.toFixed(2)),
        amount: new Prisma.Decimal(perNightAmount.toFixed(2)),
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
  // FINAL / ROOM INVOICE branch — layout matches `Commercial invoice.pdf` reference.
  // Room lines only (no F&B) — filters folio lines by lineType so SERVICE / OTHER don't
  // pollute the PARTICULAR table.
  // ================================================================
  const gstRate = Number(await requireActiveConfigValue<number>(prisma, "billing.salesTaxRate")) || 0.05;
  const svcRate = Number(await requireActiveConfigValue<number>(prisma, "billing.serviceChargeRate")) || 0.10;

  // Room lines = STAY / ROOM_CHARGE lineType. Non-room lines (F&B / OTHER / SERVICE) filtered
  // out per boss's instruction: "the thing here is this should only show the room bill".
  const roomLineTypes = new Set<string>(["ROOM_CHARGE", "STAY"]);
  const roomFolioLines = (inv.folio?.lines ?? []).filter((l) => roomLineTypes.has(l.lineType));

  // If folio has no ROOM_CHARGE (e.g. checkout not yet posted), synthesise from the accepted
  // quotation so the PDF still shows a sensible bill.
  type RoomLineDisplay = {
    particular: string;
    roomNo: string;
    nights: number;
    rate: number;
    amount: number;
    folioLineId: string | null;
  };
  const roomLines: RoomLineDisplay[] = [];
  if (roomFolioLines.length > 0) {
    for (const l of roomFolioLines) {
      roomLines.push({
        particular: "Room",
        roomNo: (l.description.match(/room\s+(\S+)/i)?.[1] ?? "").trim(),
        nights: 1, // one folio line = one night of stay charge; if the schema evolves to carry nights we adopt it
        rate: Number(toDecimal(l.amount).toFixed(2)),
        amount: Number(toDecimal(l.amount).toFixed(2)),
        folioLineId: l.id,
      });
    }
  } else {
    // Fallback: use accepted quotation's rate for each night.
    for (let i = 0; i < nights; i++) {
      roomLines.push({
        particular: "Room",
        roomNo: "",
        nights: 1,
        rate: nightlyRate,
        amount: nightlyRate,
        folioLineId: null,
      });
    }
  }

  const subtotal = roomLines.reduce((s, l) => s + l.amount, 0);
  const discountAmount = 0;
  const serviceCharge = Number((subtotal * svcRate).toFixed(2));
  const gstAmount = Number(((subtotal + serviceCharge) * gstRate).toFixed(2));
  const totalBeforeAdvance = subtotal - discountAmount + serviceCharge + gstAmount;

  const inPayments = (inv.folio?.payments ?? []).filter((p) => p.paymentDirection === "IN");
  const advanceAmount = inPayments.reduce((s, p) => s + Number(toDecimal(p.amount).toFixed(2)), 0);
  const focAmount = 0;
  const totalPayable = Number((totalBeforeAdvance - advanceAmount - focAmount).toFixed(2));

  // Travel agent name (or "Walk-In" if none). Guest name = contact person on entry (per boss's
  // convention: "guest name reflects the contact person's name").
  const travelAgentName = inv.entry.inquiry?.travelAgent?.displayName
    ?? inv.entry.inquiry?.corporateAccount?.displayName
    ?? "Walk-In";
  const displayGuestName = inv.entry.contactPersonName?.trim() || guestName;
  const contactNo = inv.entry.contactPersonPhone?.trim() || guest?.phone || "";
  const guestEmail = guest?.email ?? inv.dispatchedTo ?? "";

  const preparedByName = await getPreparedByName(prisma, actorId);
  const hotelPhone = extractPrimaryPhone(hotel.contactNumbers);

  const html = renderRoomInvoiceHtml({
    hotel,
    hotelPhone,
    invoiceNumber: invoiceRef,
    documentDate: inv.dispatchedAt ?? inv.issuedAt ?? now,
    travelAgentName,
    guestName: displayGuestName,
    contactNo,
    guestEmail,
    totalGuestsAdult: adultCount,
    totalGuestsChildren: childCount,
    checkIn,
    checkOut,
    lines: roomLines.map((l) => ({
      particular: l.particular,
      roomNo: l.roomNo,
      nights: l.nights,
      rate: l.rate,
      amount: l.amount,
    })),
    subtotal,
    discountAmount,
    discountRatePercent: 0,
    serviceChargeRatePercent: Math.round(svcRate * 100),
    serviceChargeAmount: serviceCharge,
    gstRatePercent: Math.round(gstRate * 100),
    gstAmount,
    totalBeforeAdvance,
    advanceAmount,
    focAmount,
    totalPayable,
    preparedByName,
  });

  const bytes = await renderHtmlToPdf(html);
  const checksum = hashSha256(bytes);
  const storageKey = buildStorageKey("room-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
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
          documentTitle: "ROOM INVOICE",
          invoiceRef,
          versionNumber: inv.versionNumber,
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
