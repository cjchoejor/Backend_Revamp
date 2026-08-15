import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { mulMoney, round2, sumMoneyBy, toDecimal } from "../../lib/money.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";

/**
 * ENTRY BILLING SUMMARY — the booking's money position in one read (2026-08-13, operator
 * request: the workspace header should show THE total, live, instead of the frozen per-night
 * rate; clicking it opens the full breakdown).
 *
 * Pure aggregation, nothing persisted. Closes the two figures CLAUDE.md documents as "dark"
 * on the desk because no endpoint supplied them:
 *   - a STAY TOTAL on the current commercial basis (there is no `frozenTotalAmount` column —
 *     the basis is the operative quotation of the CURRENT segment, which is exactly what a
 *     room change / re-entry re-prices, so the figure tracks upgrades automatically);
 *   - a FOLIO CHARGES TOTAL (only `outstandingBalance` was stored; the desk needed the
 *     billed-so-far figure without summing lines client-side).
 *
 * MONEY: all Decimal server-side (lib/money), returned as 2dp numbers. The folio aggregates
 * deliberately mirror `recomputeFolioOutstandingBalance` (lines − IN + OUT − write-offs) so
 * the breakdown always reconciles with the stored `outstandingBalance`.
 *
 * TWO RATE CONVENTIONS on Quotation.totalAmount (see CLAUDE.md):
 *   - composition path (desk quotes): totalAmount IS the tax-inclusive STAY total;
 *   - legacy flat path: totalAmount is per-night × roomCount — the stay total is × nights,
 *     computed HERE (Decimal) so the frontend never multiplies money.
 */

type Db = PrismaClient;

export interface EntryBillingSummary {
  entryId: string;
  generatedAt: string;
  currency: string | null;
  /** The single figure for the workspace header. */
  headline: {
    amount: number | null;
    kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null;
    /** True when the basis is frozen under a confirmed reservation on the current segment. */
    frozen: boolean;
  };
  /** Stay total on the CURRENT commercial basis (re-priced by room changes / re-entries). */
  stayTotal: {
    amount: number | null;
    basis: "COMPOSITION_STAY_TOTAL" | "PER_NIGHT_TIMES_NIGHTS" | null;
    frozen: boolean;
    quotationId: string | null;
    quotationState: string | null;
    /** Which segment the basis quotation belongs to (null when unresolvable). */
    segmentNumber: number | null;
    nights: number | null;
    /** Flat path only — the quotation row's own per-night figure. */
    perNightAmount: number | null;
  };
  /**
   * Per-room price breakdown (2026-08-13, operator request) — read from the basis quotation's
   * stored `compositionTotals.perRoom` + `roomCompositions` counts, never re-priced. Component
   * subtotals are NET (pre-tax): roomSubtotal = stored roomRate × nights, extraBedSubtotal =
   * stored extraBedRate × beds × nights, mealsSubtotal as stored (child-banded). `total` is the
   * stored tax-inclusive room total. On discounted quotes the stored per-room totals are
   * post-discount while the component rates are pre-discount — `componentsPreDiscount` says so,
   * and the desk captions it instead of implying the rows sum. Null on flat-path quotes.
   */
  rooms: Array<{
    roomId: string | null;
    roomNumber: string | null;
    roomTypeName: string | null;
    nights: number | null;
    isFoc: boolean;
    occupants: { adults: number; children6To10: number; childrenUnder6: number } | null;
    extraBedCount: number;
    mealCounts: { cp: number; mapl: number; mapd: number; ap: number; others: number } | null;
    /** True when at least one night carries a per-date meal-plan override. */
    mealsVaryByNight: boolean;
    roomSubtotal: number | null;
    extraBedSubtotal: number | null;
    mealsSubtotal: number | null;
    serviceCharge: number | null;
    gst: number | null;
    total: number | null;
    componentsPreDiscount: boolean;
  }> | null;
  /** The live ledger. Null when no folio exists yet. */
  folio: {
    state: string;
    /** Net sum of posted folio lines (charges minus corrections/credit notes). */
    billedSoFar: number | null;
    lineCount: number;
    /** Sum of IN payments — advance + settlement money actually received. */
    paymentsReceived: number | null;
    /** Sum of OUT payments (refunds). Null when none. */
    refunded: number | null;
    /** Sum of write-offs. Null when none. */
    writtenOff: number | null;
    /** The stored ledger balance (`Folio.outstandingBalance`). */
    outstandingBalance: number | null;
    /** Per-room charge subtotals (2026-08-14, operator request) — net sum of the folio lines
     *  stamped with each roomId, sealed-selection order preserved by roomNumber sort. Null
     *  when no line carries a room (legacy folios). */
    perRoomCharges: Array<{
      roomId: string;
      roomNumber: string | null;
      charges: number;
      lineCount: number;
    }> | null;
    /** Net sum + count of lines with NO room attribution (booking-wide). Null when none. */
    unassignedCharges: { charges: number; lineCount: number } | null;
  } | null;
}

function money(d: Prisma.Decimal | null): number | null {
  if (d == null) return null;
  const n = Number(round2(d).toString());
  return Number.isFinite(n) ? n : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function nightsBetween(checkIn: Date | null | undefined, checkOut: Date | null | undefined): number | null {
  if (!checkIn || !checkOut) return null;
  const ms = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 86_400_000);
}

export async function buildEntryBillingSummary(prisma: Db, entryId: string): Promise<EntryBillingSummary> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      quotations: { orderBy: { versionNumber: "desc" } },
      segments: { orderBy: { segmentNumber: "desc" }, select: { id: true, segmentNumber: true } },
      reservation: { select: { segmentId: true, frozenCheckInDate: true, frozenCheckOutDate: true, frozenCommercialTerms: true } },
      folio: { select: { id: true, state: true, outstandingBalance: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const currentSegmentId = entry.segments[0]?.id ?? null;
  const segmentNumberById = new Map(entry.segments.map((s) => [s.id, s.segmentNumber]));

  // Frozen = the CURRENT segment's basis is under a confirmed reservation (a re-entry that
  // opened a fresh segment un-freezes the figure until the re-confirmation).
  const frozen = entry.reservation != null && entry.reservation.segmentId === currentSegmentId;

  // --- Basis quotation ------------------------------------------------------------------------
  // 1. The operative quotation of the current segment (live states — the negotiation basis).
  // 2. Frozen booking whose quote row has since EXPIRED/SUPERSEDED (the W15 validity clock keeps
  //    ticking after the freeze, but expiry does NOT unfreeze the committed money): the newest
  //    quote on the reservation's segment, live states first.
  // 3. Pre-freeze with only a lapsed quote (validity ran out mid-S3): the newest non-superseded
  //    quote of the current segment — the figure the proforma billed; `quotationState` carries
  //    "EXPIRED" so the desk can flag it rather than showing a dash.
  // 4. Any ACCEPTED quotation (legacy bookings predating the segment model).
  const statePriority = (s: string): number =>
    s === "ACCEPTED" ? 5 : s === "SENT" ? 4 : s === "DRAFT" ? 3 : s === "EXPIRED" ? 2 : 1;
  const newestByPriority = (rows: typeof entry.quotations) =>
    rows.length === 0
      ? null
      : rows.reduce((best, q) => {
          const bp = statePriority(best.state);
          const qp = statePriority(q.state);
          if (qp !== bp) return qp > bp ? q : best;
          return (q.versionNumber ?? 0) > (best.versionNumber ?? 0) ? q : best;
        });
  const basisQuote =
    (currentSegmentId ? resolveOperativeQuotation(entry.quotations, currentSegmentId) : null) ??
    (frozen ? newestByPriority(entry.quotations.filter((q) => q.segmentId === entry.reservation!.segmentId)) : null) ??
    (currentSegmentId
      ? newestByPriority(entry.quotations.filter((q) => q.segmentId === currentSegmentId && q.state !== "SUPERSEDED"))
      : null) ??
    entry.quotations.find((q) => q.state === "ACCEPTED") ??
    null;

  const terms = (basisQuote?.commercialTerms ?? null) as Record<string, unknown> | null;
  const hasCompositions =
    (Array.isArray(terms?.roomCompositions) && (terms!.roomCompositions as unknown[]).length > 0) ||
    terms?.compositionTotals != null;
  const pricingBreakdown = (terms?.pricingBreakdown ?? null) as Record<string, unknown> | null;

  const nights =
    num(pricingBreakdown?.nights) ??
    nightsBetween(
      entry.reservation?.frozenCheckInDate ?? entry.checkInDate,
      entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate,
    );

  let stayTotalDec: Prisma.Decimal | null = null;
  let basis: EntryBillingSummary["stayTotal"]["basis"] = null;
  let perNightAmount: number | null = null;
  if (basisQuote?.totalAmount != null) {
    if (hasCompositions) {
      stayTotalDec = toDecimal(basisQuote.totalAmount);
      basis = "COMPOSITION_STAY_TOTAL";
    } else {
      perNightAmount = money(toDecimal(basisQuote.totalAmount));
      if (nights != null) {
        stayTotalDec = mulMoney(basisQuote.totalAmount, nights);
        basis = "PER_NIGHT_TIMES_NIGHTS";
      }
    }
  }

  // Last resort for a frozen booking with no surviving quote row: the reservation's own frozen
  // snapshot (`frozenCommercialTerms.compositionTotals.total`) — the legal record of the freeze.
  if (stayTotalDec == null && frozen) {
    const frozenTerms = (entry.reservation?.frozenCommercialTerms ?? null) as Record<string, unknown> | null;
    const frozenTotals = (frozenTerms?.compositionTotals ?? null) as Record<string, unknown> | null;
    const frozenTotal = num(frozenTotals?.total);
    if (frozenTotal != null) {
      stayTotalDec = toDecimal(frozenTotal);
      basis = "COMPOSITION_STAY_TOTAL";
    }
  }

  // --- Per-room price breakdown from the stored composition -----------------------------------
  // Read, not re-priced: `compositionTotals.perRoom` stores the rates and subtotals the quote
  // was actually priced with (child-banded meals included); the composition rows supply the
  // counts (occupants / beds / meal-plan distribution). Falls back to the reservation's frozen
  // snapshot when no quote row survived.
  const termsForRooms =
    terms ?? (frozen ? ((entry.reservation?.frozenCommercialTerms ?? null) as Record<string, unknown> | null) : null);
  let rooms: EntryBillingSummary["rooms"] = null;
  const totalsBlob = (termsForRooms?.compositionTotals ?? null) as Record<string, unknown> | null;
  const perRoomBlob = Array.isArray(totalsBlob?.perRoom) ? (totalsBlob!.perRoom as Array<Record<string, unknown>>) : null;
  if (perRoomBlob && perRoomBlob.length > 0) {
    const comps = Array.isArray(termsForRooms?.roomCompositions)
      ? (termsForRooms!.roomCompositions as Array<Record<string, unknown>>)
      : [];
    const compByRoom = new Map(comps.map((c) => [String(c.roomId ?? ""), c]));
    const discounted = termsForRooms?.compositionDiscount != null;
    const perRoomIds = perRoomBlob
      .map((r) => (typeof r.roomId === "string" ? r.roomId : null))
      .filter((x): x is string => !!x);
    const roomRows = perRoomIds.length
      ? await prisma.room.findMany({
          where: { id: { in: perRoomIds } },
          select: { id: true, roomNumber: true, roomType: { select: { name: true } } },
        })
      : [];
    const roomInfo = new Map(roomRows.map((r) => [r.id, r]));
    rooms = perRoomBlob.map((r) => {
      const roomId = typeof r.roomId === "string" ? r.roomId : null;
      const info = roomId ? roomInfo.get(roomId) ?? null : null;
      const comp = roomId ? compByRoom.get(roomId) ?? null : null;
      const roomNights = num(r.nights);
      const extraBedCount = num(comp?.extraBedCount) ?? 0;
      const roomRate = num(r.roomRate);
      const extraBedRate = num(r.extraBedRate);
      // FOC rooms store zero rates, so the component maths lands on 0 without a special case.
      const roomSubtotal = roomRate != null && roomNights != null ? money(mulMoney(roomRate, roomNights)) : null;
      const extraBedSubtotal =
        extraBedRate != null && roomNights != null
          ? money(mulMoney(mulMoney(extraBedRate, extraBedCount), roomNights))
          : null;
      const mealsSubtotal = num(r.mealsSubtotal);
      const storedSubtotal = num(r.subtotal);
      // On discounted quotes the stored subtotal/total are post-discount while the component
      // rates are pre-discount — flag the mismatch so the desk captions it honestly.
      const componentsSum =
        roomSubtotal != null && extraBedSubtotal != null && mealsSubtotal != null
          ? roomSubtotal + extraBedSubtotal + mealsSubtotal
          : null;
      const componentsPreDiscount =
        discounted && componentsSum != null && storedSubtotal != null && Math.abs(componentsSum - storedSubtotal) > 0.02;
      const breakdown = Array.isArray(r.perNightMealBreakdown)
        ? (r.perNightMealBreakdown as Array<Record<string, unknown>>)
        : [];
      return {
        roomId,
        roomNumber: (typeof r.roomNumber === "string" ? r.roomNumber : null) ?? info?.roomNumber ?? null,
        roomTypeName: info?.roomType?.name ?? null,
        nights: roomNights,
        isFoc: comp?.isFoc === true,
        occupants: comp
          ? {
              adults: num(comp.adultCount) ?? 0,
              children6To10: num(comp.cnb6To10Count) ?? 0,
              childrenUnder6: num(comp.cnbUnder6Count) ?? 0,
            }
          : null,
        extraBedCount,
        mealCounts: comp
          ? {
              cp: num(comp.mealPlanCpCount) ?? 0,
              mapl: num(comp.mealPlanMaplCount) ?? 0,
              mapd: num(comp.mealPlanMapdCount) ?? 0,
              ap: num(comp.mealPlanApCount) ?? 0,
              others: num(comp.mealPlanOthersCount) ?? 0,
            }
          : null,
        mealsVaryByNight: breakdown.some((n) => n.overridden === true),
        roomSubtotal,
        extraBedSubtotal,
        mealsSubtotal,
        serviceCharge: num(r.serviceCharge),
        gst: num(r.gst),
        total: num(r.total),
        componentsPreDiscount,
      };
    });
  }

  // --- Folio ledger — mirrors recomputeFolioOutstandingBalance's aggregates exactly ----------
  let folioBlock: EntryBillingSummary["folio"] = null;
  if (entry.folio) {
    const [lines, inAgg, outAgg, writeOffAgg] = await Promise.all([
      prisma.folioLine.findMany({
        where: { folioId: entry.folio.id },
        select: { amount: true, roomId: true, room: { select: { roomNumber: true } } },
      }),
      prisma.paymentRecord.aggregate({ where: { folioId: entry.folio.id, paymentDirection: "IN" }, _sum: { amount: true } }),
      prisma.paymentRecord.aggregate({ where: { folioId: entry.folio.id, paymentDirection: "OUT" }, _sum: { amount: true } }),
      prisma.writeOffRecord.aggregate({ where: { folioId: entry.folio.id }, _sum: { writtenOffAmount: true } }),
    ]);
    const refundedDec = toDecimal(outAgg._sum.amount);
    const writtenOffDec = toDecimal(writeOffAgg._sum.writtenOffAmount);

    // Per-room charge subtotals (2026-08-14): Decimal-summed server-side — the desk shows,
    // never sums. Lines with no roomId gather in the booking-wide bucket.
    const byRoom = new Map<string, { roomNumber: string | null; sum: Prisma.Decimal; count: number }>();
    let unassignedSum = toDecimal(0);
    let unassignedCount = 0;
    for (const l of lines) {
      if (l.roomId) {
        const cur = byRoom.get(l.roomId) ?? { roomNumber: l.room?.roomNumber ?? null, sum: toDecimal(0), count: 0 };
        cur.sum = cur.sum.add(toDecimal(l.amount));
        cur.count += 1;
        byRoom.set(l.roomId, cur);
      } else {
        unassignedSum = unassignedSum.add(toDecimal(l.amount));
        unassignedCount += 1;
      }
    }
    const perRoomCharges =
      byRoom.size > 0
        ? Array.from(byRoom.entries())
            .map(([roomId, v]) => ({
              roomId,
              roomNumber: v.roomNumber,
              charges: money(v.sum) ?? 0,
              lineCount: v.count,
            }))
            .sort((a, b) => (a.roomNumber ?? "").localeCompare(b.roomNumber ?? "", undefined, { numeric: true }))
        : null;

    folioBlock = {
      state: entry.folio.state,
      billedSoFar: lines.length > 0 ? money(sumMoneyBy(lines, "amount")) : null,
      lineCount: lines.length,
      paymentsReceived: money(toDecimal(inAgg._sum.amount)),
      refunded: refundedDec.gt(0) ? money(refundedDec) : null,
      writtenOff: writtenOffDec.gt(0) ? money(writtenOffDec) : null,
      outstandingBalance: money(toDecimal(entry.folio.outstandingBalance)),
      perRoomCharges,
      unassignedCharges: unassignedCount > 0 ? { charges: money(unassignedSum) ?? 0, lineCount: unassignedCount } : null,
    };
  }

  const stayTotal = money(stayTotalDec);
  const headline: EntryBillingSummary["headline"] =
    stayTotal != null
      ? { amount: stayTotal, kind: "STAY_TOTAL", frozen }
      : folioBlock?.billedSoFar != null
        ? { amount: folioBlock.billedSoFar, kind: "BILLED_SO_FAR", frozen }
        : { amount: null, kind: null, frozen };

  return {
    entryId: entry.id,
    generatedAt: new Date().toISOString(),
    currency: basisQuote?.currency ?? null,
    headline,
    stayTotal: {
      amount: stayTotal,
      basis,
      frozen,
      quotationId: basisQuote?.id ?? null,
      quotationState: basisQuote?.state ?? null,
      segmentNumber: basisQuote?.segmentId ? segmentNumberById.get(basisQuote.segmentId) ?? null : null,
      nights,
      perNightAmount,
    },
    rooms,
    folio: folioBlock,
  };
}
