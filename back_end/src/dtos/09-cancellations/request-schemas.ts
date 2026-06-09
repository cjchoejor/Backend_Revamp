import { z } from "zod";

export const recordCancellationDisclosureRequestSchema = z.object({
  noShowTreatmentStatement: z.string().min(1),
  disclosedTerms: z.unknown().optional(),
});
export type RecordCancellationDisclosureRequestDto = z.infer<typeof recordCancellationDisclosureRequestSchema>;

/** POST /entries/:id/cancel — optional Policy 35 penalty waiver (requires GM per SIG-S5). */
export const cancelS5EntryRequestSchema = z.object({
  penaltyWaiverRequested: z.boolean().optional(),
});
export type CancelS5EntryRequestDto = z.infer<typeof cancelS5EntryRequestSchema>;

/** POST /entries/:id/cancel-early-departure — SIG-S6 Policy 35 (FOM / GM waiver). */
export const cancelEarlyDepartureRequestSchema = z.object({
  penaltyWaiverRequested: z.boolean().optional(),
});
export type CancelEarlyDepartureRequestDto = z.infer<typeof cancelEarlyDepartureRequestSchema>;

/** POST /entries/:id/cancel-at-s3 — SIG-S3 §6.5 pre-confirmation cancellation. */
export const cancelS3EntryRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
  penaltyWaiverRequested: z.boolean().optional(),
});
export type CancelS3EntryRequestDto = z.infer<typeof cancelS3EntryRequestSchema>;
