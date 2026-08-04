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
  computeQuotationCompositionTotals,
  type RoomCompositionInput,
  type RoomCompositionRateContext,
} from "../../lib/room-composition.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
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
  /** Meal covers per night after the plan counts are expanded (what `rate × heads` multiplies). */
  breakfastPax: number;
  lunchPax: number;
  dinnerPax: number;
  roomSubtotal: number;
  extraBedSubtotal: number;
  mealsSubtotal: number;
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
  /** Grand total minus the discount — what the guest pays. */
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

  /**
   * The draft resolves ONE room rate for the whole booking and applies it to every room —
   * `prepareQuotationDraft` derives a single `roomTypeId` from the FIRST room in the seal and
   * uses the resulting `defaultRoomRate` in every room's context. On a booking mixing room
   * types that means a Deluxe is charged at the Standard rate (or the reverse), decided by
   * whichever room happens to sort first. That is a real pricing defect, reported separately.
   *
   * The preview mirrors it exactly rather than pricing each room at its own type's rate. A
   * preview that quietly showed the "correct" per-type figure would tell the operator a total
   * the quote will not produce, which is worse than the defect itself: the desk's contract is
   * to show what the backend WILL charge. When the draft is fixed, this follows it.
   */
  const sealedCfg = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  const firstSealedRoomId = sealedCfg ? firstRoomId(readOptionSelected(sealedCfg.optionSelected)) : null;
  const firstSealedRoom = firstSealedRoomId
    ? await prisma.room.findUnique({ where: { id: firstSealedRoomId }, select: { roomTypeId: true } })
    : null;
  const draftRateType = firstSealedRoom?.roomTypeId ?? null;

  const roomIds = input.roomCompositions.map((c) => c.roomId);
  const rooms = roomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: roomIds } },
        select: { id: true, roomNumber: true, roomTypeId: true },
      })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const refByType = new Map(reference.roomTypes.map((t) => [t.roomTypeId, t]));

  const stayNights =
    entry.checkInDate && entry.checkOutDate
      ? Math.max(1, Math.round((entry.checkOutDate.getTime() - entry.checkInDate.getTime()) / 86_400_000))
      : 1;

  const dec = (v: number | null | undefined): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

  // One reference for every room — the draft's single-rate behaviour (see above). Falls back to
  // the room's own type only when the seal yields no type at all.
  const draftRef = draftRateType ? refByType.get(draftRateType) : undefined;

  const priced = input.roomCompositions.map((c) => {
    const room = roomById.get(c.roomId);
    const ref = draftRef ?? (room?.roomTypeId ? refByType.get(room.roomTypeId) : undefined);
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
      nights: reference.nights ?? stayNights,
    };
    return { input: compositionInput, ctx, roomId: c.roomId, roomNumber: room?.roomNumber ?? null };
  });

  const totals = computeQuotationCompositionTotals(priced);

  const roomsOut: PreviewRoomLine[] = totals.perRoom.map((r, i) => {
    const roomSubtotal = r.perNightRoom.mul(r.nights);
    const extraBedSubtotal = r.perNightExtraBed.mul(r.nights);
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
      breakfastPax: r.effectiveBreakfastPax,
      lunchPax: r.effectiveLunchPax,
      dinnerPax: r.effectiveDinnerPax,
      roomSubtotal: n2(roomSubtotal),
      extraBedSubtotal: n2(extraBedSubtotal),
      mealsSubtotal: n2(r.mealsSubtotal),
      subtotal: n2(r.subtotal),
      serviceCharge: n2(r.serviceCharge),
      gst: n2(r.gst),
      total: n2(r.total),
      isFoc: input.roomCompositions[i]?.isFoc === true,
      hasNightMealOverrides: r.perNightMealBreakdown.some((b) => b.overridden),
    };
  });

  // The discount is measured against the grand total, in whichever way the operator expressed it.
  const grand = totals.total;
  const reqPct = input.discount?.percent ?? null;
  const reqAmt = input.discount?.amount ?? null;
  let discount: QuotationPreview["discount"] = null;
  if ((reqPct != null && reqPct > 0) || (reqAmt != null && reqAmt > 0)) {
    const off = reqAmt != null && reqAmt > 0 ? new Prisma.Decimal(reqAmt) : grand.mul(new Prisma.Decimal(reqPct ?? 0)).div(100);
    const cappedOff = off.gt(grand) ? grand : off;
    const ratio = discountRatio(grand, cappedOff);
    discount = {
      requestedPercent: reqPct,
      requestedAmount: reqAmt,
      amountOffTotal: n2(cappedOff),
      effectivePercent: grand.gt(ZERO) ? Number(round2(cappedOff.div(grand).mul(100))) : 0,
      netReduction: n2(totals.subtotal.mul(new Prisma.Decimal(1).sub(ratio))),
    };
  }

  return {
    entryId: entry.id,
    currency: reference.currency,
    nights: reference.nights,
    gstRate: reference.gstRate,
    serviceChargeRate: reference.serviceChargeRate,
    rooms: roomsOut,
    subtotal: n2(totals.subtotal),
    serviceCharge: n2(totals.serviceCharge),
    gst: n2(totals.gst),
    grandTotal: n2(grand),
    discount,
    payable: n2(grand.sub(new Prisma.Decimal(discount?.amountOffTotal ?? 0))),
  };
}
