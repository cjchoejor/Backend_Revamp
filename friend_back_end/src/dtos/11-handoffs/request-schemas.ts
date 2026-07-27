import { z } from "zod";

export const acceptHandoffRequestSchema = z.object({
  checklistCompletion: z.record(z.string(), z.boolean()).optional(),
});
export type AcceptHandoffRequestDto = z.infer<typeof acceptHandoffRequestSchema>;

export const rejectHandoffRequestSchema = z.object({
  rejectionReason: z.string().min(1),
});
export type RejectHandoffRequestDto = z.infer<typeof rejectHandoffRequestSchema>;

export const createH2HandoffRequestSchema = z.object({
  roomNumber: z.string().min(1),
  guestProfileId: z.string().nullable().optional(),
  deficientConditionStatus: z.string().nullable().optional(),
  specialHousekeepingRequests: z.unknown().optional(),
});
export type CreateH2HandoffRequestDto = z.infer<typeof createH2HandoffRequestSchema>;

export const fulfilHandoffRequestSchema = z.object({
  fulfilmentEvidence: z.record(z.string(), z.unknown()).optional(),
});
export type FulfilHandoffRequestDto = z.infer<typeof fulfilHandoffRequestSchema>;

export const createH4HandoffRequestSchema = z.object({
  autoFulfilForSameDayDeparture: z.boolean().optional(),
  notes: z.string().optional(),
});
export type CreateH4HandoffRequestDto = z.infer<typeof createH4HandoffRequestSchema>;
