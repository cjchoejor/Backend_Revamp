import { z } from "zod";

export const createInquiryRequestSchema = z.object({
  guestProfileId: z.string().min(1),
  sourceChannel: z.string().min(1),
  notes: z.string().optional(),
  /** When both set, Policy 12 runs server-side overlap detection against other inquiries for the same guest profile. */
  proposedCheckIn: z.string().optional(),
  proposedCheckOut: z.string().optional(),
  duplicateCheck: z
    .object({
      isDuplicate: z.boolean(),
      conflictingInquiryId: z.string().optional(),
    })
    .optional(),
});
export type CreateInquiryRequestDto = z.infer<typeof createInquiryRequestSchema>;

export const assignInquiryCustodianRequestSchema = z.object({
  newCustodianId: z.string().min(1),
});
export type AssignInquiryCustodianRequestDto = z.infer<typeof assignInquiryCustodianRequestSchema>;

export const parkInquiryRequestSchema = z.object({
  reason: z.string().optional(),
});
export type ParkInquiryRequestDto = z.infer<typeof parkInquiryRequestSchema>;

export const captureCorporateContextRequestSchema = z.object({
  corporateClientRef: z.string().min(1),
  corporateCoordinator: z.string().min(1),
});
export type CaptureCorporateContextRequestDto = z.infer<typeof captureCorporateContextRequestSchema>;

export const resolveDuplicateFlagRequestSchema = z.object({
  resolutionType: z.enum(["MERGE", "ACKNOWLEDGE", "DISMISS"]),
  resolutionReason: z.string().optional(),
  mergedIntoInquiryId: z.string().optional(),
});
export type ResolveDuplicateFlagRequestDto = z.infer<typeof resolveDuplicateFlagRequestSchema>;

/** `GET /inquiries` — query string. */
export const listInquiriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  guestProfileId: z.string().min(1).optional(),
});
export type ListInquiriesQueryDto = z.infer<typeof listInquiriesQuerySchema>;
