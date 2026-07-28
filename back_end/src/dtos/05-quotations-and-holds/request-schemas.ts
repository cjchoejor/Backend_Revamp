import { z } from "zod";

const discountShape = z.object({
  discountPercent: z.coerce.number(),
  discountBasis: z.string().min(1),
});

const belowMsrGmWaiverSchema = z.object({
  acknowledged: z.literal(true),
  rationale: z.string().min(3).max(4000),
});

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
});
export type RoomCompositionInputDto = z.infer<typeof roomCompositionInputSchema>;

export const createQuotationRequestSchema = z.object({
  requestedDiscount: discountShape.nullable().optional(),
  notes: z.string().optional(),
  currency: z.string().optional(),
  focRoomsRequested: z.coerce.number().int().min(1).optional(),
  belowMsrGmWaiver: belowMsrGmWaiverSchema.optional(),
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

export const applyDiscountRequestSchema = discountShape.extend({
  belowMsrGmWaiver: belowMsrGmWaiverSchema.optional(),
});
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
