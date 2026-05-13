import { z } from "zod";

const discountShape = z.object({
  discountPercent: z.coerce.number(),
  discountBasis: z.string().min(1),
});

const belowMsrGmWaiverSchema = z.object({
  acknowledged: z.literal(true),
  rationale: z.string().min(3).max(4000),
});

export const createQuotationRequestSchema = z.object({
  requestedDiscount: discountShape.nullable().optional(),
  notes: z.string().optional(),
  currency: z.string().optional(),
  focRoomsRequested: z.coerce.number().int().min(1).optional(),
  belowMsrGmWaiver: belowMsrGmWaiverSchema.optional(),
});
export type CreateQuotationRequestDto = z.infer<typeof createQuotationRequestSchema>;

export const supersedeQuotationRequestSchema = z.object({
  notes: z.string().optional(),
  requestedDiscount: discountShape.nullable().optional(),
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
