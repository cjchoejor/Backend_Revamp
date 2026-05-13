import { z } from "zod";

export const placeProcessingLockRequestSchema = z.object({
  inventoryReference: z.string().min(1),
  channel: z.enum(["EMAIL_AI", "WHATSAPP_AI", "FRONT_DESK", "PHONE"]),
  entryContext: z
    .object({
      entryId: z.string().min(1),
      segmentId: z.string().optional(),
    })
    .optional(),
});
export type PlaceProcessingLockRequestDto = z.infer<typeof placeProcessingLockRequestSchema>;
