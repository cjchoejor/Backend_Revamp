import { z } from "zod";

/**
 * A booking discount, expressed either way (2026-08-04, operator ruling): a percentage, or a
 * flat amount. Both are measured against the composition GRAND TOTAL — meals and extra beds
 * included — so they are two ways of saying the same thing and exactly one may be given.
 *
 * `discountPercent` stays optional-but-usual so every existing caller (and the production
 * frontend) keeps working unchanged.
 */
const discountObject = z.object({
  discountPercent: z.coerce.number().optional(),
  discountAmount: z.coerce.number().optional(),
  discountBasis: z.string().min(1),
});
/** Exactly one of the two — they are two ways of saying the same thing. */
const exactlyOneDiscountForm = (d: { discountPercent?: number; discountAmount?: number }) =>
  (d.discountPercent != null) !== (d.discountAmount != null);
const oneFormMessage = { message: "Provide exactly one of discountPercent or discountAmount" };
export const discountShape = discountObject.refine(exactlyOneDiscountForm, oneFormMessage);

const belowMsrGmWaiverSchema = z.object({
  acknowledged: z.literal(true),
  rationale: z.string().min(3).max(4000),
});

// Meal plan selection (S2). EP (room only) is represented by omitting mealPlan / null.
const mealPlanEnum = z.enum(["CP", "MAP_LUNCH", "MAP_DINNER", "AP"]);

/**
 * Per-room composition captured at S2 quotation build (per-room track Phase B, 2026-07-27).
 * Shape mirrors the RoomAssignment composition columns added in Phase A. `roomId` is the
 * physical Room this composition applies to — must match one of the rooms in the sealed
 * AvailabilityConfiguration's optionSelected.
 *
 * Every count / rate is optional so the operator can fill the form progressively; the
 * pricing engine treats null counts as 0 and null rates as "fall back to rate card".
 */
export const roomCompositionInputSchema = z.object({
  roomId: z.string().min(1),
  /**
   * Optional per-room date range. When absent the whole booking's dates apply
   * (Entry.checkInDate / Entry.checkOutDate). Populated when guests switch rooms mid-stay
   * (e.g., 201 for nights 1-2, 202 for night 3 — one composition per room per date range).
   */
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  // composition counts. Anyone 11+ counts as an adult (registry.child.ageBands default).
  occupantCount: z.coerce.number().int().min(0).optional(),
  adultCount: z.coerce.number().int().min(0).optional(),
  cnb6To10Count: z.coerce.number().int().min(0).optional(),
  cnbUnder6Count: z.coerce.number().int().min(0).optional(),
  extraBedCount: z.coerce.number().int().min(0).optional(),
  // meal-plan distribution (guest counts per plan)
  mealPlanCpCount: z.coerce.number().int().min(0).optional(),
  mealPlanMaplCount: z.coerce.number().int().min(0).optional(),
  mealPlanMapdCount: z.coerce.number().int().min(0).optional(),
  mealPlanApCount: z.coerce.number().int().min(0).optional(),
  mealPlanOthersCount: z.coerce.number().int().min(0).optional(),
  othersBreakfastPax: z.coerce.number().int().min(0).optional(),
  othersLunchPax: z.coerce.number().int().min(0).optional(),
  othersDinnerPax: z.coerce.number().int().min(0).optional(),
  // negotiated rates (any positive number, or omit to use rate card defaults)
  negotiatedRoomRate: z.coerce.number().min(0).optional(),
  negotiatedExtraBedRate: z.coerce.number().min(0).optional(),
  negotiatedBreakfastRate: z.coerce.number().min(0).optional(),
  negotiatedLunchRate: z.coerce.number().min(0).optional(),
  negotiatedDinnerRate: z.coerce.number().min(0).optional(),
  // room-level toggles
  serviceChargeApplies: z.boolean().optional(),
  gstApplies: z.boolean().optional(),
  isFoc: z.boolean().optional(),
  /**
   * Per-night meal-plan overrides (2026-07-28). Each entry REPLACES the room-level
   * distribution above for that one night; nights without an entry keep the default. Dates
   * must fall inside the room's stay — enforced by `enforceNightOverridesWithinStay`, not here,
   * because the stay range isn't known at schema-validation time.
   */
  nightMealOverrides: z
    .array(
      z.object({
        date: z.string().datetime(),
        mealPlanCpCount: z.coerce.number().int().min(0).optional(),
        mealPlanMaplCount: z.coerce.number().int().min(0).optional(),
        mealPlanMapdCount: z.coerce.number().int().min(0).optional(),
        mealPlanApCount: z.coerce.number().int().min(0).optional(),
        mealPlanOthersCount: z.coerce.number().int().min(0).optional(),
        othersBreakfastPax: z.coerce.number().int().min(0).optional(),
        othersLunchPax: z.coerce.number().int().min(0).optional(),
        othersDinnerPax: z.coerce.number().int().min(0).optional(),
        // Extra beds on this one night when they differ from the row's stay-wide count
        // (2026-08-19 — written by the in-house setup change; a bed-only entry leaves meals alone).
        extraBedCount: z.coerce.number().int().min(0).max(6).optional(),
      }),
    )
    .max(370)
    .optional(),
});
export type RoomCompositionInputDto = z.infer<typeof roomCompositionInputSchema>;

export const createQuotationRequestSchema = z.object({
  requestedDiscount: discountShape.nullable().optional(),
  notes: z.string().optional(),
  /**
   * Validity window in days, chosen when the quote is GENERATED (2026-08-06, operator ruling —
   * the generated quote IS the offer under the generate-vs-send rule, so its clock starts at
   * creation). 1–30; must also end before check-in (service-enforced, since the stay dates
   * aren't known here). Omitted → registry.quotationValidity.days / config default.
   */
  validDays: z.coerce.number().int().min(1).max(30).optional(),
  currency: z.string().optional(),
  focRoomsRequested: z.coerce.number().int().min(1).optional(),
  belowMsrGmWaiver: belowMsrGmWaiverSchema.optional(),
  // Phase-D meal/extra-bed (priced from the agent/corporate rate card when the booking is linked).
  // Booking-wide; per-room compositions below take precedence when supplied.
  mealPlan: mealPlanEnum.nullable().optional(),
  extraBedCount: z.coerce.number().int().min(0).max(10).optional(),
  /**
   * Per-room compositions (Phase B, 2026-07-27). When supplied, S2 quotation service uses
   * per-room iteration for pricing (adds up computed totals per room). When omitted, falls
   * back to the flat rate × nights × roomCount model — preserves backward compatibility
   * for callers that haven't been rewired to send composition yet.
   */
  roomCompositions: z.array(roomCompositionInputSchema).optional(),
});
export type CreateQuotationRequestDto = z.infer<typeof createQuotationRequestSchema>;

export const supersedeQuotationRequestSchema = z.object({
  notes: z.string().optional(),
  requestedDiscount: discountShape.nullable().optional(),
  /** Validity of the regenerated draft — same rules as create (1–30, before check-in). */
  validDays: z.coerce.number().int().min(1).max(30).optional(),
  currency: z.string().optional(),
  /** GM waiver when the renegotiated rate falls below MSR (same shape as create). */
  belowMsrGmWaiver: z.object({ acknowledged: z.literal(true), rationale: z.string().min(3).max(4000) }).optional(),
  /**
   * Renegotiated per-room compositions (2026-07-28). When supplied, the new draft is
   * re-priced with these; when omitted, the prior version's compositions carry forward
   * unchanged — a discount-only renegotiation never silently drops the composition.
   */
  roomCompositions: z.array(roomCompositionInputSchema).optional(),
});
export type SupersedeQuotationRequestDto = z.infer<typeof supersedeQuotationRequestSchema>;

export const sendQuotationRequestSchema = z.object({
  validDays: z.coerce.number().int().min(1).optional(),
  sentTo: z.string().optional(),
  channel: z.string().optional(),
  recipientAddress: z.string().optional(),
});
export type SendQuotationRequestDto = z.infer<typeof sendQuotationRequestSchema>;

export const applyDiscountRequestSchema = discountObject
  .extend({ belowMsrGmWaiver: belowMsrGmWaiverSchema.optional() })
  .refine(exactlyOneDiscountForm, oneFormMessage);
export type ApplyDiscountRequestDto = z.infer<typeof applyDiscountRequestSchema>;

export const acceptQuotationRequestSchema = z.object({
  acceptanceMethod: z.enum(["WRITTEN", "VERBAL"]).optional(),
  verbatimNote: z.string().optional(),
});
export type AcceptQuotationRequestDto = z.infer<typeof acceptQuotationRequestSchema>;

export const resolveQuotationAckOpenLoopRequestSchema = z.object({
  resolutionType: z.enum(["VERBAL_ACCEPTED", "WRITTEN_ACCEPTED", "CUSTODIAN_DECISION"]).optional(),
  note: z.string().optional(),
  decisionReason: z.string().optional(),
});
export type ResolveQuotationAckOpenLoopRequestDto = z.infer<typeof resolveQuotationAckOpenLoopRequestSchema>;

export const autoFulfilS2ToS3RequestSchema = z.object({
  version: z.coerce.number().int().optional(),
});
export type AutoFulfilS2ToS3RequestDto = z.infer<typeof autoFulfilS2ToS3RequestSchema>;

export const placeSpeculativeHoldRequestSchema = z
  .object({
    roomId: z.string().optional(),
    spaceId: z.string().optional(),
    ttlSeconds: z.coerce.number().optional(),
    commercialBasis: z.string().optional(),
    notes: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const hasRoom = !!val.roomId?.trim();
    const hasSpace = !!val.spaceId?.trim();
    if (hasRoom === hasSpace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of roomId or spaceId is required",
      });
    }
  });
export type PlaceSpeculativeHoldRequestDto = z.infer<typeof placeSpeculativeHoldRequestSchema>;

export const releaseSpeculativeHoldRequestSchema = z.object({
  releaseReason: z.string().min(1),
});
export type ReleaseSpeculativeHoldRequestDto = z.infer<typeof releaseSpeculativeHoldRequestSchema>;
