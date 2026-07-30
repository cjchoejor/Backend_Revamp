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
  formatMoney,
  getPreparedByName,
  loadHotelProfileForRender,
} from "../../lib/pdf-render-context.js";
import { toDecimal } from "../../lib/money.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderLegphelProformaHtml } from "../infrastructure/pdf-templates/legphel-proforma-template.js";
import { mastheadFromHotelProfile, primaryContactNumber } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatStayRange } from "../infrastructure/pdf-templates/legphel-document-format.js";
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
    // Per-room composition path (Phase D, 2026-07-27). When frozenCommercialTerms carries
    // compositions, render one row per room. Falls back to legacy per-night rendering when
    // no composition (older bookings + non-composition callers).
    const compositionPerRoom = (terms as unknown as {
      compositionTotals?: {
        perRoom?: Array<{ roomId: string; roomNumber: string | null; total: number }>;
      };
      roomCompositions?: Array<any>;
    })?.compositionTotals?.perRoom;

    // Per-row Amount (Nu.) on Proforma is tax-INCLUSIVE — matches the Quotation convention.
    const perNightBreakdown = await computeStayCharges(prisma, nightlyRate, 1, roomCount);
    const perNightAmount = perNightBreakdown.total;
    type PrintLine = {
      date: Date;
      roomNo?: string | null;
      occupants: string;
      mealPlan: string | null;
      extraBeds: string | null;
      amount: string | number;
    };
    const linesForTemplate: PrintLine[] = [];
    let totalAmount = 0;
    if (Array.isArray(compositionPerRoom) && compositionPerRoom.length > 0) {
      const inputsByRoomId = new Map(
        ((terms as any).roomCompositions ?? []).map((r: any) => [r.roomId, r]),
      );
      for (const r of compositionPerRoom) {
        const raw = inputsByRoomId.get(r.roomId) as any;
        const adults = raw?.adultCount ?? 0;
        const cnb = (raw?.cnb6To10Count ?? 0) + (raw?.cnbUnder6Count ?? 0);
        const rowOccupants = `${adults} adult${adults === 1 ? "" : "s"}${cnb > 0 ? `, ${cnb} child${cnb === 1 ? "" : "ren"}` : ""}`;
        const planParts: string[] = [];
        if (raw?.mealPlanCpCount) planParts.push(`${raw.mealPlanCpCount} CP`);
        if (raw?.mealPlanMaplCount) planParts.push(`${raw.mealPlanMaplCount} MAPL`);
        if (raw?.mealPlanMapdCount) planParts.push(`${raw.mealPlanMapdCount} MAPD`);
        if (raw?.mealPlanApCount) planParts.push(`${raw.mealPlanApCount} AP`);
        if (raw?.mealPlanOthersCount) planParts.push(`${raw.mealPlanOthersCount} Others`);
        const eb = raw?.extraBedCount && raw.extraBedCount > 0 ? `${raw.extraBedCount} extra bed${raw.extraBedCount === 1 ? "" : "s"}` : "None";
        linesForTemplate.push({
          date: checkIn,
          roomNo: r.roomNumber ?? r.roomId.slice(0, 6),
          occupants: rowOccupants,
          mealPlan: planParts.length > 0 ? planParts.join(" · ") : null,
          extraBeds: eb,
          amount: r.total,
        });
        totalAmount += Number(r.total);
      }
    } else {
      // Legacy per-night rendering.
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
      totalAmount = perNightAmount * nights;
    }

    // Advance and FoC pulled from the folio's payments (IN) for a real total-payable calc.
    const inPayments = (inv.folio?.payments ?? []).filter((p) => p.paymentDirection === "IN");
    const advanceAmount = inPayments.reduce((s, p) => s + Number(toDecimal(p.amount).toFixed(2)), 0);
    const focAmount = 0;
    const totalPayable = totalAmount - advanceAmount - focAmount;

    // A2 Proforma Invoice, house format (docs/bills). The Net / Service / GST figures decompose
    // the tax-inclusive total; they are not added to it.
    const ctP =
      (terms as unknown as {
        compositionTotals?: {
          subtotal?: string | number;
          serviceCharge?: string | number;
          gst?: string | number;
        };
      })?.compositionTotals ?? null;
    const balanceAtCheckout = totalPayable;
    const docDate = inv.dispatchedAt ?? inv.issuedAt ?? now;

    const html = renderLegphelProformaHtml({
      masthead: mastheadFromHotelProfile(hotel),
      proformaNo: invoiceRef,
      bookingRef: inv.entryId,
      date: formatDocDate(docDate),
      // The advance deadline lives on the payment-condition evaluation, not the invoice row, so it
      // is left off until that value is threaded through rather than printed as a guess.
      advanceDueBy: null,
      to: guest?.email ? `${guestName} · ${guest.email}` : guestName,
      forGuest: guestName,
      stayLabel: "Stay",
      stay: formatStayRange(checkIn, checkOut, nights),
      rateLabel: [occupantsString, mealPlanDisplay || null, "per night"].filter(Boolean).join(" · "),
      rateValue: formatMoney(perNightAmount),
      totalInclusive: formatMoney(totalAmount),
      decompositionNet: formatMoney(ctP?.subtotal ?? totalAmount),
      decompositionService: formatMoney(ctP?.serviceCharge ?? 0),
      decompositionGst: formatMoney(ctP?.gst ?? 0),
      advanceDueNow: formatMoney(advanceAmount > 0 ? advanceAmount : totalAmount),
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

    const bytes = await renderHtmlToPdf(html, { fitToPage: true });
    const checksum = hashSha256(bytes);
    const storageKey = buildStorageKey("proforma-invoice", `${invoiceRef}-v${inv.versionNumber}`, now);
    await writeDocument(storageKey, bytes);

    await prisma.$transaction(async (tx) => {
      const lineData: Prisma.InvoiceLineCreateManyInput[] = linesForTemplate.map((l, i) => ({
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
  //
  // Split-billing (Phase 3, 2026-07-25): when `inv.billingModel` is populated, the invoice
  // covers ONLY folio lines whose `billingModel` matches — so an agent-DIRECT_BILL invoice
  // shows just the agent's charges, a guest-GUEST_PAY invoice shows just guest charges.
  // Additionally the lineType filter is DROPPED for split invoices so F&B / SERVICE /
  // OTHER lines appear on the guest invoice (previously stripped as "room-only" filter).
  // Legacy whole-folio invoices keep the room-only filter for backward compat.
  // ================================================================
  const gstRate = Number(await requireActiveConfigValue<number>(prisma, "billing.salesTaxRate")) || 0.05;
  const svcRate = Number(await requireActiveConfigValue<number>(prisma, "billing.serviceChargeRate")) || 0.10;

  // Two independent filters:
  //   1. Split-billing filter: only lines whose billingModel matches this invoice's bucket.
  //      For legacy invoices (invoice.billingModel = null) all lines pass this filter.
  //      NULL-billingModel lines (pre-Phase-1 backfill data) pass through to whichever
  //      invoice bucket the folio's primary model resolves to — matching the ledger's
  //      NULL→primary rollup rule in `computeOutstandingForBillingModel`.
  //   2. Line-type filter: ROOM_CHARGE / STAY only, but ONLY for legacy invoices. Split
  //      invoices show all their bucket's lines regardless of type.
  const invoiceBucket = inv.billingModel ?? null;
  const primaryModel = inv.folio?.billingModel?.trim() ?? null;
  const isBucketScoped = !!invoiceBucket;
  const roomLineTypes = new Set<string>(["ROOM_CHARGE", "STAY"]);
  const bucketMatches = (lineModel: string | null | undefined) => {
    if (!isBucketScoped) return true;
    const trimmed = lineModel?.trim() ?? null;
    if (trimmed === invoiceBucket) return true;
    // Legacy NULL-model lines belong to the folio's primary model bucket.
    if (trimmed == null && primaryModel === invoiceBucket) return true;
    return false;
  };
  const filteredFolioLines = (inv.folio?.lines ?? []).filter((l) => {
    if (!bucketMatches(l.billingModel)) return false;
    if (!isBucketScoped) return roomLineTypes.has(l.lineType);
    return true;
  });

  // Synthesise from quotation ONLY for legacy whole-folio invoices where NO room charges
  // exist yet (guest hasn't checked out; PDF is a preview). Split invoices never synthesise —
  // if a bucket has zero lines, that's a real "nothing to bill this bucket" state.
  type RoomLineDisplay = {
    particular: string;
    roomNo: string;
    nights: number;
    rate: number;
    amount: number;
    folioLineId: string | null;
  };
  const roomLines: RoomLineDisplay[] = [];
  if (filteredFolioLines.length > 0) {
    for (const l of filteredFolioLines) {
      // Particular label = "Room" for room-lines (legacy visual), otherwise the folio line's
      // description (so F&B / SERVICE / OTHER lines self-identify on split invoices).
      const particular = roomLineTypes.has(l.lineType) ? "Room" : l.description;
      roomLines.push({
        particular,
        roomNo: (l.description.match(/room\s+(\S+)/i)?.[1] ?? "").trim(),
        nights: 1,
        rate: Number(toDecimal(l.amount).toFixed(2)),
        amount: Number(toDecimal(l.amount).toFixed(2)),
        folioLineId: l.id,
      });
    }
  } else if (!isBucketScoped) {
    // Legacy synthesise-from-quote fallback (only for whole-folio invoices).
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

  // Advance-payment attribution:
  //   - Legacy whole-folio invoice: all IN payments count toward this invoice's advance.
  //   - Split invoice: only payments whose `billingModel` matches this bucket count.
  //     NULL-model payments (pre-Phase-3 records) roll up to the primary bucket, mirroring
  //     the ledger. Prevents double-counting when two invoices are issued for one folio.
  const inPayments = (inv.folio?.payments ?? []).filter((p) => {
    if (p.paymentDirection !== "IN") return false;
    if (!isBucketScoped) return true;
    const pModel = p.billingModel?.trim() ?? null;
    if (pModel === invoiceBucket) return true;
    if (pModel == null && primaryModel === invoiceBucket) return true;
    return false;
  });
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
