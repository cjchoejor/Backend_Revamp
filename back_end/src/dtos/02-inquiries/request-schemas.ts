import { z } from "zod";

export const createInquiryRequestSchema = z
  .object({
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
    /** Phase C — optional link to a TravelAgent (Phase B model). Mutually exclusive with corporateAccountId. */
    travelAgentId: z.string().min(1).nullable().optional(),
    /** Phase C — optional link to a CorporateAccount (Phase B model). Mutually exclusive with travelAgentId. */
    corporateAccountId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => !(v.travelAgentId && v.corporateAccountId), {
    message: "An inquiry can be linked to a travel agent OR a corporate account, not both",
    path: ["travelAgentId"],
  });
export type CreateInquiryRequestDto = z.infer<typeof createInquiryRequestSchema>;

export const assignInquiryCustodianRequestSchema = z.object({
  newCustodianId: z.string().min(1),
});
export type AssignInquiryCustodianRequestDto = z.infer<typeof assignInquiryCustodianRequestSchema>;

export const parkInquiryRequestSchema = z.object({
  // SIG-S1 §3.3 / DEV-SPEC Part 10 — an inquiry-level park reason is required (max 500 chars).
  reason: z.string().trim().min(1, "A reason is required to park an inquiry.").max(500),
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
