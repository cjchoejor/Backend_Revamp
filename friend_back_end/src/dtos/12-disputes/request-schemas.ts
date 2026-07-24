import type { Stage } from "@prisma/client";
import { z } from "zod";

export const openDisputeRequestSchema = z.object({
  entryId: z.string().min(1),
  folioId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export type OpenDisputeRequestDto = z.infer<typeof openDisputeRequestSchema>;

export const closeDisputeRequestSchema = z.object({
  closureReason: z.string().min(1),
});
export type CloseDisputeRequestDto = z.infer<typeof closeDisputeRequestSchema>;

export const progressDisputeRequestSchema = z.object({
  status: z.enum(["IN_PROGRESS", "RESOLVED"]),
});
export type ProgressDisputeRequestDto = z.infer<typeof progressDisputeRequestSchema>;

export const createDisputeGateOverrideRequestSchema = z.object({
  targetStage: z.enum(["S8", "S9"]),
  freeTextReason: z.string().min(1),
});
export type CreateDisputeGateOverrideRequestDto = z.infer<typeof createDisputeGateOverrideRequestSchema>;

/** Mapped in router to Prisma `Stage` before calling the service. */
export type CreateDisputeGateOverrideServiceRequestDto = {
  targetStage: Stage;
  freeTextReason: string;
};
