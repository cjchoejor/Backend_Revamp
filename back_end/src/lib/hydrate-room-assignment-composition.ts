import type { Prisma, PrismaClient } from "@prisma/client";
import { computeRoomComposition, nightKeys, type RoomCompositionInput, type RoomCompositionRateContext } from "./room-composition.js";
import { round2, toDecimal } from "./money.js";
import { resolveOperativeQuotation } from "./operative-quotation.js";
import { resolveChargeRates } from "../services/infrastructure/compute-stay-charges.js";
import { loadChildPolicyBundle } from "../services/domain/child-policy-service.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The single ratio a booking discount applied to every room's net, recovered from the stored
 * terms: post-discount net ÷ pre-discount net. Falls back to the recorded effective percent
 * (2-dp) for quotes written before the reference run was stored, and to null when the booking
 * carries no discount at all.
 */
function bookingDiscountRatio(terms: {
  compositionTotals?: { subtotal?: number } | null;
  compositionTotalsPreDiscount?: { subtotal?: number } | null;
  compositionDiscount?: { effectivePercent?: number } | null;
} | null): Prisma.Decimal | null {
  const post = terms?.compositionTotals?.subtotal;
  const pre = terms?.compositionTotalsPreDiscount?.subtotal;
  if (typeof post === "number" && typeof pre === "number" && pre > 0) {
    return toDecimal(post).div(toDecimal(pre));
  }
  const pct = terms?.compositionDiscount?.effectivePercent;
  if (typeof pct === "number" && pct > 0 && pct <= 100) {
    return toDecimal(1).sub(toDecimal(pct).div(100));
  }
  return null;
}

/**
 * Hydrate per-room composition fields for a NEW RoomAssignment (Phase C, 2026-07-27).
 *
 * Reads the entry's accepted quotation's `commercialTerms.roomCompositions[]`, finds the
 * composition for the given `roomId`, and returns the fields to spread into the
 * `RoomAssignment.create({ data })` call. Recomputes `frozenSubtotal` / `frozenTotal` from
 * the composition + live tax rates so the frozen snapshot is authoritative.
 *
 * Returns `null` when:
 *   - The entry has no accepted quotation yet (pre-S4 assignments)
 *   - The accepted quotation has no `roomCompositions` (legacy / flat-pricing bookings)
 *   - No composition matches `roomId` (operator changed room selection after quotation acceptance)
 *
 * When null → caller creates the RoomAssignment WITHOUT composition fields, and the
 * night audit falls back to `Reservation.frozenRate` for the amount.
 */
export async function hydrateRoomAssignmentComposition(
  db: Db,
  entryId: string,
  roomId: string,
  opts?: {
    /**
     * Freeze only THIS window of the room's stay (2026-08-19 — the in-house setup change writes a
     * new assignment row from tonight to checkout while the quotation still prices the room for
     * the whole stay). `nights` overrides the quotation's claimed nights; `startDate` re-anchors
     * the per-night overrides so the row carries only the nights it actually covers. Omit both
     * to freeze exactly what the quotation priced (every other caller).
     */
    nights?: number;
    startDate?: Date;
  },
): Promise<Partial<Prisma.RoomAssignmentUncheckedCreateInput> | null> {
  // Generate-vs-send (2026-08-12): the S4 freeze snapshots the OPERATIVE quotation (ACCEPTED
  // when one exists, else the newest live SENT/DRAFT of the current segment), so hydration must
  // read the same row — requiring ACCEPTED here meant most desk bookings (whose quotes are
  // legitimately never sent) hydrated nothing and night audit fell back to the flat frozenRate.
  // Legacy fallback: an ACCEPTED quote from any segment, matching the old behaviour for rows
  // whose current segment carries no quotation (e.g. mid-re-entry).
  const entryRow = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      quotations: {
        orderBy: { createdAt: "desc" },
        select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true },
      },
    },
  });
  const currentSegmentId = entryRow?.segments[0]?.id;
  const operative = currentSegmentId
    ? resolveOperativeQuotation(entryRow?.quotations ?? [], currentSegmentId)
    : null;
  const basis =
    operative ?? (entryRow?.quotations ?? []).find((q) => q.state === "ACCEPTED") ?? null;
  const terms = (basis?.commercialTerms ?? null) as
    | {
        roomCompositions?: Array<{ roomId: string; [k: string]: unknown }>;
        compositionTotals?: {
          subtotal?: number;
          perRoom?: Array<{
            roomId: string;
            nights?: number;
            roomRate?: number;
            extraBedRate?: number;
            breakfastRate?: number;
            lunchRate?: number;
            dinnerRate?: number;
            /** POST-discount net + tax-inclusive figures the quotation actually priced. */
            subtotal?: number;
            total?: number;
          }>;
        } | null;
        /** Slim undiscounted reference run, stored whenever a booking discount moved the price. */
        compositionTotalsPreDiscount?: { subtotal?: number; total?: number } | null;
        compositionDiscount?: { effectivePercent?: number; amountOffTotal?: number } | null;
      }
    | null;
  const rooms = Array.isArray(terms?.roomCompositions) ? terms.roomCompositions : [];
  const composition = rooms.find((r) => r.roomId === roomId);
  if (!composition) return null;

  // The composition JSON on Quotation is the raw DTO shape (numbers, not Decimals).
  // Convert to Decimals for negotiated rates + reconstruct the RoomCompositionInput type.
  const c = composition as Record<string, unknown>;
  const numOrUndef = (k: string): number | undefined => {
    const v = c[k];
    return typeof v === "number" ? v : undefined;
  };
  const boolOrUndef = (k: string): boolean | undefined => {
    const v = c[k];
    return typeof v === "boolean" ? v : undefined;
  };
  const dateOrNull = (k: string): Date | null => {
    const v = c[k];
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const decOrNull = (k: string): Prisma.Decimal | null => {
    const v = c[k];
    return typeof v === "number" ? toDecimal(v) : null;
  };

  // Per-night meal overrides ride along in the same commercialTerms JSON as the rest of the
  // composition. Parsed here so the frozen totals below price the same nights the quotation did.
  const rawNights = Array.isArray(c.nightMealOverrides) ? (c.nightMealOverrides as unknown[]) : [];
  const nightMealOverrides = rawNights.flatMap((n) => {
    if (!n || typeof n !== "object") return [];
    const o = n as Record<string, unknown>;
    const d = typeof o.date === "string" ? new Date(o.date) : null;
    if (!d || Number.isNaN(d.getTime())) return [];
    const int = (k: string): number | undefined => (typeof o[k] === "number" ? (o[k] as number) : undefined);
    return [{
      date: d,
      mealPlanCpCount: int("mealPlanCpCount"),
      mealPlanMaplCount: int("mealPlanMaplCount"),
      mealPlanMapdCount: int("mealPlanMapdCount"),
      mealPlanApCount: int("mealPlanApCount"),
      mealPlanOthersCount: int("mealPlanOthersCount"),
      othersBreakfastPax: int("othersBreakfastPax"),
      othersLunchPax: int("othersLunchPax"),
      othersDinnerPax: int("othersDinnerPax"),
      // Per-night extra-bed count (2026-08-19) — priced night by night like the meals.
      extraBedCount: int("extraBedCount"),
    }];
  });
  /** Whether an override says anything about meals — bed-only overrides are pricing data, not a
   *  kitchen fact, so they must not become a RoomNightMealPlan row of zero covers. */
  const carriesMeals = (o: (typeof nightMealOverrides)[number]) =>
    o.mealPlanCpCount != null ||
    o.mealPlanMaplCount != null ||
    o.mealPlanMapdCount != null ||
    o.mealPlanApCount != null ||
    o.mealPlanOthersCount != null ||
    o.othersBreakfastPax != null ||
    o.othersLunchPax != null ||
    o.othersDinnerPax != null;

  const compositionInput: RoomCompositionInput = {
    nightMealOverrides,
    occupantCount: numOrUndef("occupantCount"),
    adultCount: numOrUndef("adultCount"),
    cnb6To10Count: numOrUndef("cnb6To10Count"),
    cnbUnder6Count: numOrUndef("cnbUnder6Count"),
    extraBedCount: numOrUndef("extraBedCount"),
    mealPlanCpCount: numOrUndef("mealPlanCpCount"),
    mealPlanMaplCount: numOrUndef("mealPlanMaplCount"),
    mealPlanMapdCount: numOrUndef("mealPlanMapdCount"),
    mealPlanApCount: numOrUndef("mealPlanApCount"),
    mealPlanOthersCount: numOrUndef("mealPlanOthersCount"),
    othersBreakfastPax: numOrUndef("othersBreakfastPax"),
    othersLunchPax: numOrUndef("othersLunchPax"),
    othersDinnerPax: numOrUndef("othersDinnerPax"),
    negotiatedRoomRate: decOrNull("negotiatedRoomRate"),
    negotiatedExtraBedRate: decOrNull("negotiatedExtraBedRate"),
    negotiatedBreakfastRate: decOrNull("negotiatedBreakfastRate"),
    negotiatedLunchRate: decOrNull("negotiatedLunchRate"),
    negotiatedDinnerRate: decOrNull("negotiatedDinnerRate"),
    serviceChargeApplies: boolOrUndef("serviceChargeApplies"),
    gstApplies: boolOrUndef("gstApplies"),
    isFoc: boolOrUndef("isFoc"),
    // A window re-anchor (S7 setup change) starts the row's nights at ITS first night, so the
    // per-night overrides — and the "nights that differ" — line up with the dates it covers.
    startDate: opts?.startDate ?? dateOrNull("startDate"),
    endDate: opts?.startDate ? null : dateOrNull("endDate"),
  };

  // Rate context for the "frozen" computation. The quotation's own priced figures — stored per
  // room in `commercialTerms.compositionTotals.perRoom` (rates actually used + claimed nights) —
  // are authoritative; falling back to the composition's negotiated fields, then 0. Before
  // 2026-08-12 only the negotiated fields were read, so a room priced at its type's default rate
  // froze `frozenSubtotal` from rate 0 (the documented "hydration freezing per-room totals from
  // 0" wrong-pull) and night audit silently fell back to the flat frozenRate.
  const priced = (terms?.compositionTotals?.perRoom ?? []).find((r) => r.roomId === roomId) ?? null;
  const decFromPriced = (v: number | undefined): Prisma.Decimal | null =>
    typeof v === "number" && Number.isFinite(v) ? toDecimal(v) : null;
  const { serviceChargeRate, gstRate } = await resolveChargeRates(db);
  // Age-band meal shares, so the frozen figure matches what the quotation priced rather than
  // charging a 6–10 child the adult rate at the moment of the freeze.
  const childPolicy = await loadChildPolicyBundle(db as never);
  const ctx: RoomCompositionRateContext = {
    defaultRoomRate: decFromPriced(priced?.roomRate) ?? decOrNull("negotiatedRoomRate") ?? toDecimal(0),
    defaultExtraBedRate: decFromPriced(priced?.extraBedRate) ?? decOrNull("negotiatedExtraBedRate") ?? toDecimal(0),
    defaultBreakfastRate: decFromPriced(priced?.breakfastRate) ?? decOrNull("negotiatedBreakfastRate") ?? toDecimal(0),
    defaultLunchRate: decFromPriced(priced?.lunchRate) ?? decOrNull("negotiatedLunchRate") ?? toDecimal(0),
    defaultDinnerRate: decFromPriced(priced?.dinnerRate) ?? decOrNull("negotiatedDinnerRate") ?? toDecimal(0),
    serviceChargeRate,
    gstRate,
    childMealPricing: childPolicy.mealPricing,
    // The nights the quotation actually priced this room for (per-room on a per-night seal) —
    // or the caller's own window (S7 setup change: tonight → checkout).
    ...(typeof opts?.nights === "number" && opts.nights > 0
      ? { nights: Math.floor(opts.nights) }
      : typeof priced?.nights === "number" && priced.nights > 0
        ? { nights: priced.nights }
        : {}),
  };

  const computed = computeRoomComposition(compositionInput, ctx);

  // ── The BOOKING DISCOUNT must survive the freeze (2026-08-21, operator report: "the frozen
  // amount and the amount after night audit don't match") ─────────────────────────────────
  // `compositionTotals.perRoom[]` stores each room's POST-discount `subtotal`/`total`, but the
  // RATES stored beside them are deliberately PRE-discount — the document prints the negotiated
  // rate and shows the concession once, at booking level (2026-08-02 ruling). Re-pricing from
  // those rates therefore froze the UNDISCOUNTED figures: the night audit posted `frozenSubtotal
  // ÷ nights` per night, so the ledger (and the final invoice, which is a view of it) billed the
  // guest MORE than the quotation, the proforma and the workspace header all say — by exactly
  // the discount. The quotation's own per-room figures are the commercial truth, so they win.
  const storedSubtotal = decFromPriced(priced?.subtotal);
  const storedTotal = decFromPriced(priced?.total);
  const windowed = (typeof opts?.nights === "number" && opts.nights > 0) || !!opts?.startDate;
  let frozenSubtotal = computed.subtotal;
  let frozenTotal = computed.total;
  if (!windowed && storedSubtotal && storedTotal) {
    // The row covers exactly the nights the quotation priced → take its figures verbatim, so
    // Σ frozenTotal reconciles with the stay total to the cent instead of merely approximating it.
    frozenSubtotal = storedSubtotal;
    frozenTotal = storedTotal;
  } else if (windowed) {
    // A re-anchored window (the in-house setup change freezes tonight → checkout) prices only
    // its own nights, so the stored stay figure cannot be used as-is. The discount was ONE ratio
    // over every room's net, so apply that ratio and recompute SC/GST from the discounted net —
    // exactly what `applyBookingDiscountToTotals` does at quote time.
    const ratio = bookingDiscountRatio(terms);
    if (ratio && !ratio.eq(1)) {
      frozenSubtotal = round2(computed.subtotal.mul(ratio));
      const sc =
        compositionInput.serviceChargeApplies !== false && serviceChargeRate > 0
          ? frozenSubtotal.mul(serviceChargeRate)
          : toDecimal(0);
      const gst =
        compositionInput.gstApplies !== false && gstRate > 0
          ? frozenSubtotal.add(sc).mul(gstRate)
          : toDecimal(0);
      frozenTotal = round2(frozenSubtotal.add(sc).add(gst));
    }
  }

  // Only the overrides this row's nights actually include are recorded on it (a re-anchored
  // window drops the slept nights' entries), and only those that say something about meals.
  const rowNightKeys = new Set(nightKeys(compositionInput, computed.nights));
  const overridesForRow = nightMealOverrides.filter(
    (o) => carriesMeals(o) && (rowNightKeys.size === 0 || rowNightKeys.has(o.date.toISOString().slice(0, 10))),
  );

  return {
    // composition counts (11+ counted as adult)
    occupantCount: compositionInput.occupantCount ?? null,
    adultCount: compositionInput.adultCount ?? null,
    cnb6To10Count: compositionInput.cnb6To10Count ?? null,
    cnbUnder6Count: compositionInput.cnbUnder6Count ?? null,
    extraBedCount: compositionInput.extraBedCount ?? null,
    // meal-plan distribution
    mealPlanCpCount: compositionInput.mealPlanCpCount ?? 0,
    mealPlanMaplCount: compositionInput.mealPlanMaplCount ?? 0,
    mealPlanMapdCount: compositionInput.mealPlanMapdCount ?? 0,
    mealPlanApCount: compositionInput.mealPlanApCount ?? 0,
    mealPlanOthersCount: compositionInput.mealPlanOthersCount ?? 0,
    othersBreakfastPax: compositionInput.othersBreakfastPax ?? null,
    othersLunchPax: compositionInput.othersLunchPax ?? null,
    othersDinnerPax: compositionInput.othersDinnerPax ?? null,
    // negotiated rates
    negotiatedRoomRate: compositionInput.negotiatedRoomRate ?? null,
    negotiatedExtraBedRate: compositionInput.negotiatedExtraBedRate ?? null,
    negotiatedBreakfastRate: compositionInput.negotiatedBreakfastRate ?? null,
    negotiatedLunchRate: compositionInput.negotiatedLunchRate ?? null,
    negotiatedDinnerRate: compositionInput.negotiatedDinnerRate ?? null,
    // toggles
    serviceChargeApplies: compositionInput.serviceChargeApplies ?? true,
    gstApplies: compositionInput.gstApplies ?? true,
    isFoc: compositionInput.isFoc ?? false,
    // frozen totals — the quotation's own post-discount per-room figures where the row covers
    // the nights it priced, else recomputed for this window and discounted by the same ratio.
    frozenSubtotal,
    frozenTotal,
    // Nested-create the per-night overrides alongside the assignment, so the durable record
    // matches what was priced. Cascades on delete with the assignment.
    ...(overridesForRow.length > 0
      ? {
          nightMealPlans: {
            create: overridesForRow.map((o) => ({
              date: o.date,
              mealPlanCpCount: o.mealPlanCpCount ?? 0,
              mealPlanMaplCount: o.mealPlanMaplCount ?? 0,
              mealPlanMapdCount: o.mealPlanMapdCount ?? 0,
              mealPlanApCount: o.mealPlanApCount ?? 0,
              mealPlanOthersCount: o.mealPlanOthersCount ?? 0,
              othersBreakfastPax: o.othersBreakfastPax ?? null,
              othersLunchPax: o.othersLunchPax ?? null,
              othersDinnerPax: o.othersDinnerPax ?? null,
              createdBy: "SYSTEM",
            })),
          },
        }
      : {}),
  };
}
