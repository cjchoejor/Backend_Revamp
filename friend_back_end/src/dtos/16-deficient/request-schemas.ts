import { z } from "zod";

export const finalizeDeficientConditionRequestSchema = z.object({
  status: z.enum(["RESOLVED", "UNRESOLVED"]),
  resolutionNotes: z.string().optional(),
});
export type FinalizeDeficientConditionRequestDto = z.infer<typeof finalizeDeficientConditionRequestSchema>;
