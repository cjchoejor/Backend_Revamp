/**
 * Live pricing for the S2 composition table — the same arithmetic the quotation runs, with
 * nothing persisted.
 *
 * Until now the composition editor was input-capture only: money appeared after "Create quote",
 * because the desk is forbidden from doing money arithmetic (CLAUDE.md — every financial figure
 * the desk shows is read from the API). So the operator negotiated blind, entering rates and
 * meal plans with no running total, and only found out what the booking came to once the quote
 * was generated. This is the endpoint CLAUDE.md's open item 3 calls for.
 *
 * It reuses `buildEntryRateReference` for rate resolution and `computeQuotationCompositionTotals`
 * for the arithmetic — the exact two pieces `prepareQuotationDraft` uses — so the preview and the
 * generated quote cannot disagree. Nothing is written: no Quotation, no QuotationLine, no trace,
 * no PDF. Re-running it has no effect on the booking.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import {
  applyBookingDiscountToTotals,
  autoAddRequiredExtraBeds,
  computeQuotationCompositionTotals,
  type RoomCompositionInput,
  type RoomCompositionRateContext,
} from "../../lib/room-composition.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { readOptionSelected, firstRoomId } from "../../lib/option-selected-reader.js";

const ZERO = new Prisma.Decimal(0);

/** One room's composition as the desk sends it — mirrors `QuotationDraftInput.roomCompositions`. */
export type PreviewRoomComposition = {
  roomId: string;
  occupantCount?: number;
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
  negotiatedRoomRate?: number;
  negotiatedExtraBedRate?: number;
  negotiatedBreakfastRate?: number;
  negotiatedLunchRate?: number;
  negotiatedDinnerRate?: number;
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  isFoc?: boolean;
  startDate?: string | null;
  endDate?: string | null;
  nightMealOverrides?: Array<{
    date: string;
    mealPlanCpCount?: number;
    mealPlanMaplCount?: number;
    mealPlanMapdCount?: number;
    mealPlanApCount?: number;
    mealPlanOthersCount?: number;
    othersBreakfastPax?: number;
    othersLunchPax?: number;
    othersDinnerPax?: number;
  }>;
};

/**
 * The booking discount, as the operator expressed it.
 *
 * Two ways of saying the same thing (2026-08-04, operator ruling): a percentage, or a flat
 * amount. Both are measured against the table's GRAND TOTAL — everything in it, meals and extra
 * beds included — not against the room rate alone. Per-room negotiated rates are a separate
 * mechanism: they set what a room costs, and the discount then comes off the total of whatever
 * the table adds up to.
 */
export type PreviewDiscount = { percent?: number | null; amount?: number | null };

export type PreviewRoomLine = {
  roomId: string;
  roomNumber: string | null;
  nights: number;
  /** Rates actually used — the negotiated one where set, else the resolved default. */
  roomRate: number;
  extraBedRate: number;
  breakfastRate: number;
  lunchRate: number;
  dinnerRate: number;
  extraBedCount: number;
  /** True when the mandatory extra bed (3+ adults, none supplied) was added automatically —
   *  `extraBedCount` already includes it; the desk shows the correction instead of a 0 cell
   *  silently pricing a bed. */
  extraBedAutoAdded: boolean;
  /** Meal covers per night after the plan counts are expanded (what `rate × heads` multiplies). */
  breakfastPax: number;
  lunchPax: number;
  dinnerPax: number;
  roomSubtotal: number;
  extraBedSubtotal: number;
  mealsSubtotal: number;
  /** `mealsSubtotal` split by meal — what the rate columns' per-row `heads × rate` shows.
   *  Whole-stay figures, age-banded and per-night-override-aware. */
  breakfastSubtotal: number;
  lunchSubtotal: number;
  dinnerSubtotal: number;
  /** Net of tax — room + extra beds + meals. */
  subtotal: number;
  serviceCharge: number;
  gst: number;
  /** Tax-inclusive total for this room, before any booking discount. */
  total: number;
  isFoc: boolean;
  /** True when per-date meal plans mean this room's meals are not one multiplication. */
  hasNightMealOverrides: boolean;
};

export type QuotationPreview = {
  entryId: string;
  currency: string;
  nights: number | null;
  gstRate: number;
  serviceChargeRate: number;
  rooms: PreviewRoomLine[];
  /**
   * Per-column stay totals across every room (2026-08-07) — the Σ row under the negotiation
   * table's rate columns. All NET of tax (they sum to `subtotal`); the discount does not touch
   * them (the document prints originals with the deduction as its own row).
   */
  columns: {
    room: number;
    extraBed: number;
    breakfast: number;
    lunch: number;
    dinner: number;
    /** breakfast + lunch + dinner — for consumers that keep meals as one column. */
    meals: number;
  };
  /** Column totals across every room, before the discount. */
  subtotal: number;
  serviceCharge: number;
  gst: number;
  grandTotal: number;
  discount: {
    /** What the operator entered. */
    requestedPercent: number | null;
    requestedAmount: number | null;
    /** Money actually coming off the grand total. */
    amountOffTotal: number;
    /** The same deduction expressed as a share of the grand total — what the authority bands
     *  are measured in, and what the quote records. */
    effectivePercent: number;
    /** The net-level reduction that produces it (see `applyDiscountToTotals`). */
    netReduction: number;
  } | null;
  /** Column totals after the deduction. Equal to the pre-discount ones when there is none. */
  payableSubtotal: number;
  payableServiceCharge: number;
  payableGst: number;
  /** What the guest pays. */
  payable: number;
};

const n2 = (d: Prisma.Decimal): number => Number(round2(d));

/**
 * Scale every room's NET by one ratio so the grand total falls by exactly the requested figure.
 *
 * The operator asks for "X off the total", but a discount cannot simply be subtracted from the
 * tax-inclusive grand total: service charge and GST would still be computed on the undiscounted
 * amount, and the hotel would remit GST on money it never received. Since
 * `total = net × (1 + sc) × (1 + gst)` for each room, reducing every room's net by the same
 * ratio `r` reduces the grand total by exactly the same ratio — so the guest sees precisely the
 * figure asked for, and each room's tax is charged on the true consideration.
 *
 * Rooms differ in whether service charge and GST apply at all, which is why this scales net per
 * room and re-derives tax rather than working backwards from one blended factor.
 */
function discountRatio(grandTotal: Prisma.Decimal, off: Prisma.Decimal): Prisma.Decimal {
  if (grandTotal.lte(ZERO)) return new Prisma.Decimal(1);
  const capped = off.gt(grandTotal) ? grandTotal : off;
  return grandTotal.sub(capped).div(grandTotal);
}

export async function buildQuotationPreview(
  prisma: PrismaClient,
  entryId: string,
  input: { roomCompositions: PreviewRoomComposition[]; discount?: PreviewDiscount | null },
): Promise<QuotationPreview> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      checkInDate: true,
      checkOutDate: true,
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  // Same resolution the rate-reference strip shows and the draft uses: agent/corporate card
  // where one exists, else the standard rate plan, per ROOM TYPE.
  const reference = await buildEntryRateReference(prisma, entryId);
  // Age-band meal shares, so a previewed child meal costs what the quote will charge.
  const childPolicy = await loadChildPolicyBundle(prisma);

  /**
   * Each room prices at its OWN type's rate, matching `prepareQuotationDraft` since 2026-08-04.
   *
   * Both used to charge every room one rate — resolved from whichever room sorted first in the
   * seal — so a mixed-type booking billed a Suite at the Standard rate or the reverse. The draft
   * was fixed to resolve per type; this follows it, because the preview's whole value is being
   * the figure the quote will actually produce.
   *
   * The fallback for a type the reference could not resolve is the preferred type's rate, which
   * is what the draft falls back to as well.
   */
  const sealedCfg = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  const firstSealedRoomId = sealedCfg ? firstRoomId(readOptionSelected(sealedCfg.optionSelected)) : null;
  const firstSealedRoom = firstSealedRoomId
    ? await prisma.room.findUnique({ where: { id: firstSealedRoomId }, select: { roomTypeId: true } })
    : null;
  const fallbackRateType = firstSealedRoom?.roomTypeId ?? null;

  const roomIds = input.roomCompositions.map((c) => c.roomId);
  const rooms = roomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: roomIds } },
        select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { maxExtraBeds: true } } },
      })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const refByType = new Map(reference.roomTypes.map((t) => [t.roomTypeId, t]));

  // Same auto-add the draft applies (2026-08-12): a non-FOC room with 3+ adults and no extra
  // bed prices WITH one — the preview's whole value is being the figure the quote will
  // actually produce. Order/length are preserved, so the by-index reads below stay valid;
  // the per-room `extraBedAutoAdded` flag tells the desk to show the correction.
  const bedNorm = autoAddRequiredExtraBeds(input.roomCompositions, {
    maxExtraBedsForRoom: (c) => roomById.get(c.roomId)?.roomType?.maxExtraBeds ?? null,
  });
  input = { ...input, roomCompositions: bedNorm.compositions };
  const autoAddedIndexes = new Set(bedNorm.autoAddedIndexes);

  const stayNights =
    entry.checkInDate && entry.checkOutDate
      ? Math.max(1, Math.round((entry.checkOutDate.getTime() - entry.checkInDate.getTime()) / 86_400_000))
      : 1;

  const dec = (v: number | null | undefined): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

  const fallbackRef = fallbackRateType ? refByType.get(fallbackRateType) : undefined;

  const priced = input.roomCompositions.map((c) => {
    const room = roomById.get(c.roomId);
    const ref = (room?.roomTypeId ? refByType.get(room.roomTypeId) : undefined) ?? fallbackRef;
    const compositionInput: RoomCompositionInput = {
      nightMealOverrides: (c.nightMealOverrides ?? []).map((o) => ({ ...o, date: new Date(o.date) })),
      occupantCount: c.occupantCount,
      adultCount: c.adultCount,
      cnb6To10Count: c.cnb6To10Count,
      cnbUnder6Count: c.cnbUnder6Count,
      extraBedCount: c.extraBedCount,
      mealPlanCpCount: c.mealPlanCpCount,
      mealPlanMaplCount: c.mealPlanMaplCount,
      mealPlanMapdCount: c.mealPlanMapdCount,
      mealPlanApCount: c.mealPlanApCount,
      mealPlanOthersCount: c.mealPlanOthersCount,
      othersBreakfastPax: c.othersBreakfastPax,
      othersLunchPax: c.othersLunchPax,
      othersDinnerPax: c.othersDinnerPax,
      negotiatedRoomRate: c.negotiatedRoomRate != null ? new Prisma.Decimal(c.negotiatedRoomRate) : null,
      negotiatedExtraBedRate: c.negotiatedExtraBedRate != null ? new Prisma.Decimal(c.negotiatedExtraBedRate) : null,
      negotiatedBreakfastRate: c.negotiatedBreakfastRate != null ? new Prisma.Decimal(c.negotiatedBreakfastRate) : null,
      negotiatedLunchRate: c.negotiatedLunchRate != null ? new Prisma.Decimal(c.negotiatedLunchRate) : null,
      negotiatedDinnerRate: c.negotiatedDinnerRate != null ? new Prisma.Decimal(c.negotiatedDinnerRate) : null,
      serviceChargeApplies: c.serviceChargeApplies,
      gstApplies: c.gstApplies,
      isFoc: c.isFoc,
      startDate: c.startDate ? new Date(c.startDate) : entry.checkInDate,
      endDate: c.endDate ? new Date(c.endDate) : entry.checkOutDate,
    };
    const ctx: RoomCompositionRateContext = {
      defaultRoomRate: dec(ref?.roomRate),
      defaultExtraBedRate: dec(ref?.extraBedRate),
      defaultBreakfastRate: dec(ref?.breakfastRate),
      defaultLunchRate: dec(ref?.lunchRate),
      defaultDinnerRate: dec(ref?.dinnerRate),
      serviceChargeRate: reference.serviceChargeRate,
      gstRate: reference.gstRate,
      childMealPricing: childPolicy.mealPricing,
      nights: reference.nights ?? stayNights,
    };
    return { input: compositionInput, ctx, roomId: c.roomId, roomNumber: room?.roomNumber ?? null };
  });

  const totals = computeQuotationCompositionTotals(priced);

  // Column accumulators — summed as Decimals so the Σ row is exact, not a float re-sum.
  let colRoom = ZERO;
  let colExtraBed = ZERO;
  let colBreakfast = ZERO;
  let colLunch = ZERO;
  let colDinner = ZERO;
  const roomsOut: PreviewRoomLine[] = totals.perRoom.map((r, i) => {
    const roomSubtotal = r.perNightRoom.mul(r.nights);
    const extraBedSubtotal = r.perNightExtraBed.mul(r.nights);
    colRoom = colRoom.add(roomSubtotal);
    colExtraBed = colExtraBed.add(extraBedSubtotal);
    colBreakfast = colBreakfast.add(r.breakfastSubtotal);
    colLunch = colLunch.add(r.lunchSubtotal);
    colDinner = colDinner.add(r.dinnerSubtotal);
    return {
      roomId: r.roomId,
      roomNumber: r.roomNumber,
      nights: r.nights,
      roomRate: n2(r.roomRate),
      extraBedRate: n2(r.extraBedRate),
      breakfastRate: n2(r.breakfastRate),
      lunchRate: n2(r.lunchRate),
      dinnerRate: n2(r.dinnerRate),
      extraBedCount: input.roomCompositions[i]?.extraBedCount ?? 0,
      extraBedAutoAdded: autoAddedIndexes.has(i),
      breakfastPax: r.effectiveBreakfastPax,
      lunchPax: r.effectiveLunchPax,
      dinnerPax: r.effectiveDinnerPax,
      roomSubtotal: n2(roomSubtotal),
      extraBedSubtotal: n2(extraBedSubtotal),
      mealsSubtotal: n2(r.mealsSubtotal),
      breakfastSubtotal: n2(r.breakfastSubtotal),
      lunchSubtotal: n2(r.lunchSubtotal),
      dinnerSubtotal: n2(r.dinnerSubtotal),
      subtotal: n2(r.subtotal),
      serviceCharge: n2(r.serviceCharge),
      gst: n2(r.gst),
      total: n2(r.total),
      isFoc: input.roomCompositions[i]?.isFoc === true,
      hasNightMealOverrides: r.perNightMealBreakdown.some((b) => b.overridden),
    };
  });

  // The discount is measured against the grand total, in whichever way the operator expressed it.
  // Exactly the helper the draft applies, so a previewed discount and a generated one cannot
  // come out differently.
  const applied = applyBookingDiscountToTotals(totals, priced, {
    percent: input.discount?.percent ?? null,
    amount: input.discount?.amount ?? null,
  });

  return {
    entryId: entry.id,
    currency: reference.currency,
    nights: reference.nights,
    gstRate: reference.gstRate,
    serviceChargeRate: reference.serviceChargeRate,
    rooms: roomsOut,
    columns: {
      room: n2(colRoom),
      extraBed: n2(colExtraBed),
      breakfast: n2(colBreakfast),
      lunch: n2(colLunch),
      dinner: n2(colDinner),
      meals: n2(colBreakfast.add(colLunch).add(colDinner)),
    },
    subtotal: n2(totals.subtotal),
    serviceCharge: n2(totals.serviceCharge),
    gst: n2(totals.gst),
    grandTotal: n2(totals.total),
    discount: applied
      ? {
          requestedPercent: input.discount?.percent ?? null,
          requestedAmount: input.discount?.amount ?? null,
          amountOffTotal: n2(applied.amountOffTotal),
          effectivePercent: Number(round2(applied.effectivePercent)),
          netReduction: n2(applied.netReduction),
        }
      : null,
    // Column totals AFTER the deduction — net, service charge and GST all move with it, which is
    // the whole reason the discount is taken off net rather than off the tax-inclusive total.
    payableSubtotal: applied ? n2(applied.totals.subtotal) : n2(totals.subtotal),
    payableServiceCharge: applied ? n2(applied.totals.serviceCharge) : n2(totals.serviceCharge),
    payableGst: applied ? n2(applied.totals.gst) : n2(totals.gst),
    payable: applied ? n2(applied.totals.total) : n2(totals.total),
  };
}
