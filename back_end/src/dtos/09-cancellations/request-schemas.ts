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
