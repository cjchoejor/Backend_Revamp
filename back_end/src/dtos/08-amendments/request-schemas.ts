import { Stage } from "@prisma/client";
import { z } from "zod";

export const roomChangeReEntryS1RequestSchema = z.object({
  amendmentType: z.literal("ROOM_CHANGE"),
  newRoomId: z.string().min(1),
  reason: z.string().min(1),
});
export type RoomChangeReEntryS1RequestDto = z.infer<typeof roomChangeReEntryS1RequestSchema>;

export const createAmendmentEventRequestSchema = z.object({
  amendmentType: z.string().min(1).refine((t) => t !== "ROOM_CHANGE", { message: "Use ROOM_CHANGE branch for room changes" }),
  segmentId: z.string().min(1),
  amendmentPath: z.enum(["PATH_1", "PATH_2", "PATH_3"]),
  requestedBy: z.string().min(1),
  authorisedBy: z.string().min(1),
  authorityBasis: z.string().min(1),
  reason: z.string().min(1),
  priorTermsRef: z.string().optional(),
  newTermsSummary: z.string().min(1),
  folioLineId: z.string().optional(),
  stageAtAmendment: z.nativeEnum(Stage).optional(),
});
export type CreateAmendmentEventRequestDto = z.infer<typeof createAmendmentEventRequestSchema>;

export const amendEntryRequestSchema = z.union([roomChangeReEntryS1RequestSchema, createAmendmentEventRequestSchema]);
export type AmendEntryRequestDto = z.infer<typeof amendEntryRequestSchema>;

export const s7RoomChangeReEnterS1RequestSchema = z.object({
  newRoomId: z.string().min(1),
  reason: z.string().min(1),
});
export type S7RoomChangeReEnterS1RequestDto = z.infer<typeof s7RoomChangeReEnterS1RequestSchema>;
