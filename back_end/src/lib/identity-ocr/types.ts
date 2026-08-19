/**
 * Identity extraction (OCR / QR) — shared shapes (2026-08-18).
 *
 * The extraction produces a SUGGESTION for the guest-detail table, never a write. The phone
 * capture page and the server-side worker both feed the same shape, and the desk applies it
 * through the ordinary `saveGuestIdentityDetail` path (coverage gate, p16 allowlist, traces).
 */

/** Suggested values for the guest-detail row. All optional — whatever the document yielded. */
export type IdentitySuggestedFields = {
  /** A code from the `identity.documentTypes` vocabulary — mapped server-side, never invented. */
  documentType?: string;
  documentNumber?: string;
  /** Aadhaar's Secure QR carries only the LAST FOUR digits of the number. */
  documentNumberLast4?: string;
  fullName?: string;
  /** ISO YYYY-MM-DD. */
  dateOfBirth?: string;
  /** "M" | "F" | "X" (as printed on the document; the desk maps to its own labels). */
  gender?: string;
  nationality?: string;
  /** ISO YYYY-MM-DD. */
  expiryDate?: string;
};

/**
 * How much the value can be trusted:
 *  - VERIFIED — proven by the document itself (an MRZ field whose check digit passed).
 *  - READ     — decoded/recognised but not provable (QR text, plain OCR, phone-typed edits).
 */
export type FieldConfidence = "VERIFIED" | "READ";

export type IdentityExtraction = {
  fields: IdentitySuggestedFields;
  fieldConfidence: Partial<Record<keyof IdentitySuggestedFields, FieldConfidence>>;
  /** The machine-readable payload the fields were parsed from — reproducible on the server. */
  raw: { mrzLines?: string[]; qrText?: string; source?: string; /** Layout pass: the OCR lines the fields were anchored in (first 60). */ ocrLines?: string[] };
  /** True when nothing usable was found. */
  empty: boolean;
};

/** SERVER_LAYOUT (Phase B, 2026-08-18) = Florence-2 / tesseract page OCR + label-anchored parsing. */
export const OCR_ENGINES = ["PHONE_QR", "PHONE_MRZ", "PHONE_MANUAL", "SERVER_QR", "SERVER_MRZ", "SERVER_LAYOUT"] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export const OCR_SUGGESTION_STATUSES = ["PENDING", "READY", "EMPTY", "FAILED", "APPLIED", "DISMISSED"] as const;
export type OcrSuggestionStatus = (typeof OCR_SUGGESTION_STATUSES)[number];
