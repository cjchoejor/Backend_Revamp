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
  /** Undiscounted plan rate — effectiveRate is this after the discount is folded in. */
  resolvedNightlyRate?: string | number;
  discountAppliedPercent?: number;
  requestedDiscount?: { discountPercent?: number; discountBasis?: string } | null;
  currency?: string;
  roomTypeId?: string;
  pricingBreakdown?: { nightlyRate?: number | string; nights?: number; roomCount?: number; subTotal?: number | string };
  mealPlan?: string;
  extraBeds?: string | number;
  perGuestMealBreakdown?: { total?: number | string };
  /** Original (undiscounted) figures, stored at quote time when a discount moved the rate. */
  compositionTotalsPreDiscount?: {
    total?: number;
    perRoom?: Array<{ roomId: string; total: number }>;
  } | null;
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

/** "10%" / "5%" / "12.5%" — a derived rate can land a hair off a round number, so trim rather
 *  than round to whole percent and print a rate the amounts don't support. */
function formatRate(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

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

/**
 * A printed row of the booking table. Since 2026-08-03 (operator request) a room is billed
 * across SEVERAL rows — the room, then its extra beds and each meal plan indented beneath —
 * so every row reads as `rate × qty = amount` instead of one opaque per-room total with the
 * meal charge buried in the description.
 *
 * On the composition path these amounts are NET of tax (the Net / Service charge / GST rows
 * beneath then add up to the Total), because a tax-inclusive figure is not `rate × qty` and
 * the arithmetic has to be checkable. The legacy flat path is unchanged and still prints
 * tax-inclusive per-night rows — see the fallback branch.
 */
type PrintLine = {
  description: string;
  /** The multiplier as printed: "3 nights", "2 pax × 3 nights". */
  qty: string;
  /** Unit rate, or null when the row has no single one (meals that vary night to night). */
  rate: number | null;
  amount: number;
  /** Sub-line of the room above it. */
  indent?: boolean;
};

/**
 * One row per room (composition path) or per night (flat path), carrying the tax-INCLUSIVE
 * amount. This is what the immutable `QuotationLine` snapshot stores, and it is deliberately
 * NOT the printed row set: `QuotationLine` has no description / rate / quantity columns, so
 * persisting the split rows would need a migration and would lose exactly the columns that
 * make them meaningful. The snapshot therefore keeps the shape it has always had.
 */
type SnapshotLine = {
  date: Date;
  occupants: string;
  mealPlan: string | null;
  extraBeds: string | null;
  amount: number;
};

/** Everything the PDF path persists plus the composed HTML — shared with the preview path. */
type QuotationDocRender = {
  html: string;
  linesForTemplate: PrintLine[];
  snapshotLines: SnapshotLine[];
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
  // Booking-wide meal charge on the flat path — `perGuestMealBreakdown.total` is what the pricing
  // engine attached for the whole stay, so the per-night row states its share.
  const legacyMealTotal = Number(terms?.perGuestMealBreakdown?.total ?? NaN);
  const legacyMealPerNight =
    Number.isFinite(legacyMealTotal) && legacyMealTotal > 0 ? legacyMealTotal / Math.max(1, nights) : null;
  const mealPlanDisplay = mealPlanCode
    ? `${adultCount + childCount} ${mealPlanCode}${legacyMealPerNight != null ? ` — meals ${formatMoney(legacyMealPerNight)}` : ""}`
    : "";
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
        /** Unit rates the pricing run resolved for this room — what the split rows print. */
        roomRate?: number;
        extraBedRate?: number;
        breakfastRate?: number;
        lunchRate?: number;
        dinnerRate?: number;
        subtotal?: number;
        mealsSubtotal?: number;
        perNightMeals?: number;
        perNightMealBreakdown?: Array<{ date: string; meals: number; overridden: boolean; extraBeds?: number }>;
        /** Stored night-by-night extra-bed figure (2026-08-19); absent on older quotes. */
        extraBedSubtotal?: number;
        extraBedsVaryByNight?: boolean;
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
      othersBreakfastPax?: number;
      othersLunchPax?: number;
      othersDinnerPax?: number;
      negotiatedRoomRate?: number | null;
      isFoc?: boolean;
    }>;
  })?.compositionTotals?.perRoom;

  // Discount display (2026-08-02, operator ruling): the table prints the ORIGINAL
  // (pre-discount) prices and the discount appears as an explicit deduction row, instead of
  // silently printing discounted rates. Applies only when the rate actually moved
  // (agent/corporate card rates are negotiated, not discounted — pre === post there).
  const preDiscountRate = Number(terms?.resolvedNightlyRate ?? NaN);
  const postDiscountRate = Number(terms?.effectiveRate ?? NaN);
  const discountPercent = Number(
    terms?.discountAppliedPercent ?? terms?.requestedDiscount?.discountPercent ?? NaN,
  );
  const discountApplied =
    Number.isFinite(preDiscountRate) &&
    Number.isFinite(postDiscountRate) &&
    Number.isFinite(discountPercent) &&
    discountPercent > 0 &&
    preDiscountRate > postDiscountRate;
  // NB: `compositionTotalsPreDiscount` (stored at quote time) holds tax-INCLUSIVE per-room
  // originals. The split rows are net, so the original room rate is taken straight from
  // `resolvedNightlyRate` instead — exact at the net level and needs no stored snapshot. The
  // stored field is left alone; it remains the flat path's and history's record.

  const linesForTemplate: PrintLine[] = [];
  const snapshotLines: SnapshotLine[] = [];
  let totalAmount = 0;
  // Sum of the amounts actually PRINTED in the table (pre-discount when originals are shown).
  let printedRowsTotal = 0;
  // True when the rows show original prices — decides deduction-row vs disclosure fallback.
  let originalsPrinted = false;
  // Composition path prints NET rows that add up to Net value; the legacy flat path prints
  // tax-inclusive rows. The closing note has to say which, so it's tracked here.
  let rowsAreNet = false;
  // Room-type names for the description column — the reference A1 leads its description with
  // the type ("Deluxe · 1 room · 2 adults · MAP"), so resolve names for whichever rooms the
  // lines will mention (composition rooms, else the legacy sealed room type).
  if (Array.isArray(compositionPerRoom) && compositionPerRoom.length > 0) {
    const roomRows = await prisma.room.findMany({
      where: { id: { in: compositionPerRoom.map((r) => r.roomId) } },
      select: { id: true, roomType: { select: { name: true } } },
    });
    const typeNameByRoomId = new Map(roomRows.map((r) => [r.id, r.roomType?.name ?? null]));
    const inputsByRoomId = new Map(
      ((terms as any).roomCompositions ?? []).map((r: any) => [r.roomId, r]),
    );
    rowsAreNet = true;
    const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
    for (const r of compositionPerRoom) {
      const raw = inputsByRoomId.get(r.roomId) as any;
      const roomNights = Math.max(1, Number(r.nights ?? nights));
      const adults = raw?.adultCount ?? 0;
      const cnb = (raw?.cnb6To10Count ?? 0) + (raw?.cnbUnder6Count ?? 0);
      const roomOccupants = `${adults} adult${adults === 1 ? "" : "s"}${cnb > 0 ? `, ${cnb} child${cnb === 1 ? "" : "ren"}` : ""}`;
      const planParts: string[] = [];
      if (raw?.mealPlanCpCount) planParts.push(`${raw.mealPlanCpCount} CP`);
      if (raw?.mealPlanMaplCount) planParts.push(`${raw.mealPlanMaplCount} MAP+L`);
      if (raw?.mealPlanMapdCount) planParts.push(`${raw.mealPlanMapdCount} MAP+D`);
      if (raw?.mealPlanApCount) planParts.push(`${raw.mealPlanApCount} AP`);
      if (raw?.mealPlanOthersCount) planParts.push(`${raw.mealPlanOthersCount} Others`);
      const eb =
        raw?.extraBedCount && raw.extraBedCount > 0
          ? `${raw.extraBedCount} extra bed${raw.extraBedCount === 1 ? "" : "s"}`
          : "None";

      // ── Room row ────────────────────────────────────────────────────────────────
      // Under a discount the ORIGINAL rate is printed and the deduction gets its own row
      // (2026-08-02 ruling). A room carrying its own negotiated rate is exempt: the pricing
      // ignores the default rate for it, so it costs the same discounted or not.
      const negotiatedRoomRate = raw?.negotiatedRoomRate;
      const printedRoomRate =
        discountApplied && negotiatedRoomRate == null ? preDiscountRate : Number(r.roomRate ?? 0);
      if (printedRoomRate > Number(r.roomRate ?? 0)) originalsPrinted = true;
      const roomAmount = printedRoomRate * roomNights;
      const push = (line: PrintLine) => {
        linesForTemplate.push(line);
        printedRowsTotal += line.amount;
      };
      const roomRowIndex = linesForTemplate.length;
      push({
        description: [
          r.roomNumber ? `Room ${r.roomNumber}` : `Room ${r.roomId.slice(0, 6)}`,
          typeNameByRoomId.get(r.roomId) ?? null,
          roomOccupants,
          raw?.isFoc ? "FOC" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        qty: nightsWord(roomNights),
        rate: printedRoomRate,
        amount: roomAmount,
      });

      // ── Extra beds ──────────────────────────────────────────────────────────────
      const bedCount = Number(raw?.extraBedCount ?? 0);
      const bedRate = Number(r.extraBedRate ?? 0);
      if (r.extraBedsVaryByNight === true && Number(r.extraBedSubtotal ?? 0) > 0) {
        // The bed count changed part-way through the stay (in-house setup change, 2026-08-19) —
        // one multiplication can't describe it, so print the stored night-by-night figure.
        push({
          description: `Extra bed · varies by night`,
          qty: nightsWord(roomNights),
          rate: null,
          amount: Number(r.extraBedSubtotal),
        });
      } else if (bedCount > 0 && bedRate > 0) {
        push({
          description: `Extra bed`,
          qty: `${bedCount} × ${nightsWord(roomNights)}`,
          rate: bedRate,
          amount: bedRate * bedCount * roomNights,
        });
      }

      // ── Meals, one row per plan ─────────────────────────────────────────────────
      // A plan's per-head nightly rate is the sum of the meals it includes, which is exactly
      // how `paxFromMealPlanCounts` prices it — so `planRate × pax × nights` summed over the
      // plans reproduces the stored `mealsSubtotal` to the cent.
      const bf = Number(r.breakfastRate ?? 0);
      const lu = Number(r.lunchRate ?? 0);
      const di = Number(r.dinnerRate ?? 0);
      const mealsSubtotal = Number((r as unknown as { mealsSubtotal?: number | string }).mealsSubtotal ?? 0);
      const nightBreakdown =
        (r as unknown as { perNightMealBreakdown?: Array<{ overridden?: boolean }> }).perNightMealBreakdown ?? [];
      const varyingNights = nightBreakdown.some((n) => n.overridden);
      if (varyingNights && mealsSubtotal > 0) {
        // Per-date plans: no single rate × qty describes the stay, so state the stay total and
        // say why rather than printing a multiplication that doesn't hold.
        push({
          description: `Meals · varies by night${planParts.length ? ` (usually ${planParts.join(" · ")})` : ""}`,
          qty: nightsWord(roomNights),
          rate: null,
          amount: mealsSubtotal,
        });
      } else {
        const planRows: Array<{ label: string; pax: number; rate: number }> = [
          { label: "CP (breakfast)", pax: Number(raw?.mealPlanCpCount ?? 0), rate: bf },
          { label: "MAP+L (breakfast, lunch)", pax: Number(raw?.mealPlanMaplCount ?? 0), rate: bf + lu },
          { label: "MAP+D (breakfast, dinner)", pax: Number(raw?.mealPlanMapdCount ?? 0), rate: bf + di },
          { label: "AP (all meals)", pax: Number(raw?.mealPlanApCount ?? 0), rate: bf + lu + di },
        ];
        for (const p of planRows) {
          if (p.pax > 0 && p.rate > 0) {
            push({
              description: `Meals · ${p.label}`,
              qty: `${p.pax} pax × ${nightsWord(roomNights)}`,
              rate: p.rate,
              amount: p.rate * p.pax * roomNights,
            });
          }
        }
        // "Others" guests order à la carte, so their meals are priced per meal taken rather
        // than by a plan — one row per meal that actually has pax on it.
        const alaCarte: Array<{ label: string; pax: number; rate: number }> = [
          { label: "breakfast", pax: Number(raw?.othersBreakfastPax ?? 0), rate: bf },
          { label: "lunch", pax: Number(raw?.othersLunchPax ?? 0), rate: lu },
          { label: "dinner", pax: Number(raw?.othersDinnerPax ?? 0), rate: di },
        ];
        for (const a of alaCarte) {
          if (a.pax > 0 && a.rate > 0) {
            push({
              description: `Meals · à la carte ${a.label}`,
              qty: `${a.pax} pax × ${nightsWord(roomNights)}`,
              rate: a.rate,
              amount: a.rate * a.pax * roomNights,
            });
          }
        }
      }

      // Everything pushed after this room's own row is a sub-line of it.
      for (let i = roomRowIndex + 1; i < linesForTemplate.length; i++) linesForTemplate[i].indent = true;

      // The archival snapshot keeps its one-row-per-room, tax-inclusive shape.
      snapshotLines.push({
        date: checkIn,
        occupants: roomOccupants,
        mealPlan: planParts.length > 0 ? planParts.join(" · ") : "EP (room only)",
        extraBeds: eb,
        amount: Number(r.total),
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
    // Flat path: the original per-night amount is recomputable directly from the undiscounted
    // rate — same Decimal-safe charge computation, no stored snapshot needed.
    let printedPerNight = perNightAmount;
    if (discountApplied) {
      const preBreakdown = await computeStayCharges(prisma, preDiscountRate, 1, roomCount);
      printedPerNight = preBreakdown.total;
      originalsPrinted = true;
    }
    for (let i = 0; i < nights; i++) {
      const date = new Date(checkIn.getTime() + i * 86_400_000);
      linesForTemplate.push({
        description: [legacyTypeName, occupantsString, mealPlanDisplay || null, extraBeds !== "None" ? extraBeds : null]
          .filter(Boolean)
          .join(" · "),
        qty: "1 night",
        rate: printedPerNight,
        amount: printedPerNight,
      });
      snapshotLines.push({
        date,
        occupants: occupantsString,
        mealPlan: mealPlanDisplay || null,
        extraBeds,
        amount: printedPerNight,
      });
    }
    printedRowsTotal = printedPerNight * nights;
    totalAmount = perNightAmount * nights;
  }

  const advanceAmount = 0; // No advance recorded on S2 quotations
  const focAmount = 0;
  const totalPayable = totalAmount - advanceAmount - focAmount;

  const hotel = await loadHotelProfileForRender(prisma);
  const toEmail = guest?.email ?? q.sentTo ?? "";
  const fromName = hotel.hotelName;
  const documentDate = q.sentAt ?? new Date();

  // A1 Quotation, house format (docs/bills). On the composition path the row amounts are NET
  // and the Net / Service charge / GST rows add up to the Total; on the legacy flat path the
  // rows stay tax-INCLUSIVE and those rows decompose the same figure. Either way the
  // decomposition is read from the priced terms rather than recomputed.
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
  const netValue = ct ? Number(ct.subtotal ?? 0) : totalAmount;
  const serviceCharge = ct ? Number(ct.serviceCharge ?? 0) : 0;
  const gstValue = ct ? Number(ct.gst ?? 0) : 0;
  // Percentages for the Service charge / GST labels. `compositionTotals` stores the AMOUNTS but
  // never stored the rates, so both labels printed bare ("Service charge", "GST") on every
  // quotation. Deriving them from the very figures being printed is exact and self-consistent —
  // and right for older quotes too, which were priced under whatever rates were configured at
  // the time and must not be relabelled with today's. Service charge is a share of net; GST is
  // COMPOUND — a share of (net + service charge) — which is how every engine computes it.
  const shareOf = (part: number, base: number) => (base > 0 ? part / base : 0);
  const scRate = Number(ct?.serviceChargeRate ?? shareOf(serviceCharge, netValue));
  const gstRate = Number(ct?.gstRate ?? shareOf(gstValue, netValue + serviceCharge));

  // Discount row: when the table shows ORIGINAL prices, this is a real deduction — the printed
  // rows minus what the guest is actually charged. That comparison has to be like-for-like, so
  // net rows are measured against Net value and tax-inclusive rows against the Total. Older
  // discounted quotes with no original to print fall back to the rate-movement disclosure.
  const discountBaseline = rowsAreNet ? netValue : totalAmount;
  const discountAmount = originalsPrinted ? printedRowsTotal - discountBaseline : 0;
  const discountLabel = discountApplied ? `Discount ${discountPercent}%` : null;
  const discountValue = !discountApplied
    ? null
    : originalsPrinted
      ? `− ${formatMoney(discountAmount)}`
      : `${formatMoney(preDiscountRate)} → ${formatMoney(postDiscountRate)} / room / night`;

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
      description: l.description,
      qty: l.qty,
      rate: l.rate == null ? "—" : formatMoney(l.rate),
      amount: formatMoney(l.amount),
      indent: l.indent,
    })),
    discountLabel,
    discountValue,
    netValue: formatMoney(netValue),
    serviceChargeLabel: scRate > 0 ? `Service charge ${formatRate(scRate)} of net value` : "Service charge",
    serviceCharge: formatMoney(serviceCharge),
    // GST is compound, so the label says what it is charged ON — otherwise "5%" next to a figure
    // that is not 5% of net value reads as an error to anyone checking the sums.
    gstLabel: gstRate > 0 ? `GST @ ${formatRate(gstRate)} of net + service charge` : "GST",
    gst: formatMoney(gstValue),
    total: formatMoney(totalAmount),
    closingNote:
      (rowsAreNet
        ? "Each room is billed on its own line, with its extra beds and meal plans beneath it; " +
          "meal rates are per person per night. Line amounts are before service charge and GST, " +
          "which are added below. "
        : "Rates are inclusive of service charge and GST, and of the meal charges shown against " +
          "each meal plan (those are stated before tax). ") +
      "Subject to availability at confirmation. " +
      "A proforma invoice with advance terms follows on acceptance.",
    tariffVersion: "T1.0",
  });

  return {
    html,
    linesForTemplate,
    snapshotLines,
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
    // QuotationLine snapshot — one row per ROOM (composition path) or per night (flat path),
    // carrying that room's tax-inclusive stay total. Deliberately not the printed row set:
    // since 2026-08-03 the document splits a room into room / extra-bed / meal-plan lines, and
    // this table has no description / rate / quantity columns to hold them (see SnapshotLine).
    const lineData: Prisma.QuotationLineCreateManyInput[] = m.snapshotLines.map((l, i) => ({
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
