import { z } from "zod";

/**
 * Backflow request DTOs. All 9 spec-mandated regression paths take `{ reason }` (mandatory,
 * captured in the ENTRY.BACKFLOW_* trace). The date-extension backflow additionally requires
 * `newCheckOutDate` (ISO date string, validated at parse time).
 *
 * Note: no `expectedVersion` here — the current backflow implementation uses `entry.currentStage`
 * as the pre-condition rather than a version check. Add optimistic-lock support later if we see
 * concurrent-edit conflicts in practice.
 */

export const backflowReasonRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type BackflowReasonRequestDto = z.infer<typeof backflowReasonRequestSchema>;

export const backflowS7ToS4RequestSchema = z.object({
  reason: z.string().min(1).max(500),
  newCheckOutDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/u)),
});
export type BackflowS7ToS4RequestDto = z.infer<typeof backflowS7ToS4RequestSchema>;
