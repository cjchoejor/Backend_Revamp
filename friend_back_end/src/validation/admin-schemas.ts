import { z } from "zod";

/** Dev/test helper — not an Atlas Cat 10 production route group. */
export const adminEnqueueRequestSchema = z.object({
  jobName: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  startAfterMs: z.coerce.number().optional(),
});
export type AdminEnqueueRequestDto = z.infer<typeof adminEnqueueRequestSchema>;
