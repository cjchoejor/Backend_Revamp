import { z } from "zod";

export const runNightAuditRequestSchema = z.object({
  operatingDate: z.string().min(1),
});
export type RunNightAuditRequestDto = z.infer<typeof runNightAuditRequestSchema>;

/** Path param: calendar date (YYYY-MM-DD); normalized to UTC midnight for `NightAuditRecord.operatingDate`. */
export const nightAuditOperatingDateParamSchema = z.object({
  operatingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type NightAuditOperatingDateParamDto = z.infer<typeof nightAuditOperatingDateParamSchema>;
