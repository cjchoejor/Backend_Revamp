import { z } from "zod";

export const verifyGuestIdentityRequestSchema = z.object({
  entryId: z.string().min(1),
  verificationPath: z.enum(["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"]),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
  issuingCountry: z.string().optional(),
  expiryDate: z.string().optional(),
});
export type VerifyGuestIdentityRequestDto = z.infer<typeof verifyGuestIdentityRequestSchema>;
