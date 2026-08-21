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

/** Confirm / unlock guests' typed details (2026-08-21): a confirmed row is read-only until
 *  it is unlocked again ("Make changes"). Several slots at once — the desk's per-row buttons
 *  send one key, its section-level control sends every filled row. */
export const confirmGuestIdentityDetailsRequestSchema = z.object({
  subjectKeys: z.array(z.string().trim().min(1).max(16)).min(1).max(64),
  confirmed: z.boolean(),
});
export type ConfirmGuestIdentityDetailsRequestDto = z.infer<typeof confirmGuestIdentityDetailsRequestSchema>;

/** Mint a phone identity-capture token (2026-08-12): one party slot, or the WHOLE party
 *  (`allSlots` — the phone page lists every guest and files each photo under the slot the
 *  phone user picks, server-validated). */
export const mintIdentityCapturePhoneTokenRequestSchema = z.object({
  subjectKey: z.string().trim().min(1).max(16).optional().nullable(),
  subjectLabel: z.string().trim().max(160).optional().nullable(),
  allSlots: z.boolean().optional(),
});
export type MintIdentityCapturePhoneTokenRequestDto = z.infer<typeof mintIdentityCapturePhoneTokenRequestSchema>;

export const verifyGuestIdentityRequestSchema = z.object({
  entryId: z.string().min(1),
  verificationPath: z.enum(["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"]),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
  issuingCountry: z.string().optional(),
  expiryDate: z.string().optional(),
});
export type VerifyGuestIdentityRequestDto = z.infer<typeof verifyGuestIdentityRequestSchema>;

/** Phone-side identity extraction (2026-08-18): the RAW machine-readable payload the phone
 *  decoded (server re-parses it) + the fields the person on the phone confirmed/corrected. */
export const identityExtractionSuggestedFieldsSchema = z
  .object({
    documentType: z.string().trim().max(40).optional().nullable(),
    documentNumber: z.string().trim().max(64).optional().nullable(),
    documentNumberLast4: z.string().trim().max(4).optional().nullable(),
    fullName: z.string().trim().max(160).optional().nullable(),
    dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/,"dateOfBirth must be yyyy-mm-dd").optional().nullable(),
    gender: z.string().trim().max(8).optional().nullable(),
    nationality: z.string().trim().max(8).optional().nullable(),
    expiryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/,"expiryDate must be yyyy-mm-dd").optional().nullable(),
  })
  .partial();
export const phoneIdentityExtractionRequestSchema = z.object({
  photoDocumentId: z.string().trim().min(1).max(64),
  mrzLines: z.array(z.string().trim().max(60)).max(3).optional().nullable(),
  qrText: z.string().max(20_000).optional().nullable(),
  fields: identityExtractionSuggestedFieldsSchema.optional().nullable(),
});
export type PhoneIdentityExtractionRequestDto = z.infer<typeof phoneIdentityExtractionRequestSchema>;

/** Desk: apply an OCR suggestion, optionally with the operator's corrections. */
export const applyIdentityOcrSuggestionRequestSchema = z.object({
  overrides: identityExtractionSuggestedFieldsSchema
    .pick({ documentType: true, documentNumber: true, fullName: true, dateOfBirth: true, gender: true })
    .optional()
    .nullable(),
});
