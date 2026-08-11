import { z } from "zod";

export const createGuestProfileRequestSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    nationality: z.string().trim().optional(),
    clientTier: z.string().trim().optional(),
  })
  .refine((data) => !!(data.email || data.phone), {
    message: "At least one of email or phone is required",
    path: ["email"],
  })
  .refine((data) => !data.email || z.string().email().safeParse(data.email).success, {
    message: "Invalid email address",
    path: ["email"],
  });
export type CreateGuestProfileRequestDto = z.infer<typeof createGuestProfileRequestSchema>;

export const searchGuestProfilesQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
export type SearchGuestProfilesQueryDto = z.infer<typeof searchGuestProfilesQuerySchema>;

/** Arrival guest-detail table (2026-08-10): typed details for ONE party member. Everything
 *  but the slot key is optional — the operator fills what the document shows. */
export const saveGuestIdentityDetailRequestSchema = z.object({
  subjectKey: z.string().trim().min(1).max(16),
  subjectLabel: z.string().trim().max(160).optional().nullable(),
  /** One of the configured `identity.documentTypes` codes (service validates via p16). */
  documentType: z.string().trim().max(40).optional().nullable(),
  documentNumber: z.string().trim().max(64).optional().nullable(),
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be yyyy-mm-dd")
    .optional()
    .nullable(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional().nullable(),
});
export type SaveGuestIdentityDetailRequestDto = z.infer<typeof saveGuestIdentityDetailRequestSchema>;

export const verifyGuestIdentityRequestSchema = z.object({
  entryId: z.string().min(1),
  verificationPath: z.enum(["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"]),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
  issuingCountry: z.string().optional(),
  expiryDate: z.string().optional(),
});
export type VerifyGuestIdentityRequestDto = z.infer<typeof verifyGuestIdentityRequestSchema>;
