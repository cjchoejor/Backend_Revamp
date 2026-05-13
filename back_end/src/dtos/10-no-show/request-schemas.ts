import { z } from "zod";

export const noShowContactAttemptSchema = z.object({
  channel: z.string().min(1),
  attemptedAt: z.string().min(1),
  outcome: z.string().min(1),
  response: z.string().optional(),
});

export const determineNoShowRequestSchema = z.object({
  determinationPath: z.enum(["SUB_PATH_1", "DEFER", "REACTIVATE"]),
  contactAttemptLog: z.array(noShowContactAttemptSchema),
  decisionReason: z.string().min(1),
  awaitingConfirmationWindowMinutes: z.coerce.number().int().optional(),
});
export type NoShowContactAttemptDto = z.infer<typeof noShowContactAttemptSchema>;
export type DetermineNoShowRequestDto = z.infer<typeof determineNoShowRequestSchema>;
