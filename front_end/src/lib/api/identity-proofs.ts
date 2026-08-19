import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { authHeaders } from "./documents";

/**
 * Guest ID proof files (2026-08-10) — photos/scans of the guest's physical ID captured at the
 * desk. Bytes live in the backend's write-once document store (same place as the bill PDFs);
 * these endpoints move them. The UPLOAD is deliberately NOT JSON: the file's raw bytes are the
 * request body (base64-in-JSON would inflate a phone photo ~33% and trip the body-size limit),
 * so it goes through its own fetch with the same auth headers the PDF downloads use.
 */

export type IdentityProofSummary = {
  id: string;
  entryId: string | null;
  documentType: string | null;
  /** Passport / permit number as typed in the guest-detail table. */
  documentNumber: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  note: string | null;
  /** Party slot this proof belongs to ("A0".."An" adults, "K0".."Km" children; null = unassigned). */
  subjectKey: string | null;
  /** The person's recorded name (typed off the document) or slot label ("Adult 2"). */
  subjectLabel: string | null;
  /** ISO timestamp at UTC midnight of the recorded date of birth. */
  dateOfBirth: string | null;
  gender: string | null;
  capturedAt: string;
  capturedBy: string;
  retentionExpiresAt: string;
  /** True on photo/scan rows; false on the per-guest typed DETAIL rows. */
  hasFile: boolean;
};

/** Config-driven document-type vocabulary (`identity.documentTypes`) — the guest-detail
 *  table's dropdown AND the S6 verification select read this, never a hardcoded list. */
export type IdentityDocumentTypeOption = { code: string; name: string };

/** The S6 check-in gate's verdict (2026-08-11): every party slot needs a typed document
 *  number OR a stored ID photo; VIP bookings are exempt. Server-computed — the desk mirrors,
 *  never re-derives. */
export type GuestDetailsCoverage = {
  vipExempt: boolean;
  totalSlots: number;
  filledSlots: number;
  missing: { key: string; label: string }[];
  satisfied: boolean;
};

/** The profile-holder's most recent document on file from BEFORE this booking (prior stay's
 *  primary-guest row or an S6 typed verification) — used to auto-fill the primary guest's
 *  row for returning guests. Null for first-time guests. */
export type ReturningGuestDocument = {
  documentType: string | null;
  documentNumber: string | null;
  /** ISO timestamp at UTC midnight. */
  dateOfBirth: string | null;
  gender: string | null;
  capturedAt: string;
};

export type IdentityProofsResponse = {
  items: IdentityProofSummary[];
  documentTypes: IdentityDocumentTypeOption[];
  coverage: GuestDetailsCoverage;
  returningGuest: ReturningGuestDocument | null;
  /** OCR/QR suggestions per photo (2026-08-18) — see OcrSuggestion; unapplied READY ones render under the row. */
  suggestions?: OcrSuggestion[];
};

/** Upsert one party member's typed details (document type + number, name, DOB, gender). */
export async function saveGuestIdentityDetail(
  session: Session,
  entryId: string,
  body: {
    subjectKey: string;
    subjectLabel?: string | null;
    /** One of the configured document-type codes from `documentTypes` on the list response. */
    documentType?: string | null;
    documentNumber?: string | null;
    /** yyyy-mm-dd */
    dateOfBirth?: string | null;
    gender?: "MALE" | "FEMALE" | "OTHER" | null;
  },
) {
  return apiRequest<IdentityProofSummary>(`/api/entries/${entryId}/identity-details`, {
    method: "PUT",
    session,
    body,
  });
}

/** Every stored proof for this booking's guest — including ones captured on earlier stays
 *  (`entryId` says which booking each was taken on) — plus the document-type vocabulary and
 *  the check-in coverage verdict. */
export async function listIdentityProofs(session: Session, entryId: string) {
  return apiRequest<IdentityProofsResponse>(`/api/entries/${entryId}/identity-proofs`, { session });
}

export async function uploadIdentityProof(
  session: Session,
  entryId: string,
  file: File,
  meta: { documentType?: string; note?: string; subjectKey?: string; subjectLabel?: string },
): Promise<IdentityProofSummary> {
  const params = new URLSearchParams();
  if (file.name) params.set("fileName", file.name);
  if (meta.documentType) params.set("documentType", meta.documentType);
  if (meta.note?.trim()) params.set("note", meta.note.trim());
  if (meta.subjectKey?.trim()) params.set("subjectKey", meta.subjectKey.trim());
  if (meta.subjectLabel?.trim()) params.set("subjectLabel", meta.subjectLabel.trim());
  const res = await fetch(`/api/entries/${entryId}/identity-proofs?${params}`, {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": file.type || "application/octet-stream" },
    body: file,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = `Upload failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as IdentityProofSummary;
}

/** Authenticated file endpoint for a stored proof — fetch as a blob (`fetchPdfObjectUrl`
 *  works for images too); a bare <img src> would 401. */
export function identityProofFileUrl(proofId: string): string {
  return `/api/identity-proofs/${proofId}/file`;
}

/**
 * Phone capture handoff (2026-08-12) — the desk mints a short-lived scoped token, encodes it
 * into a QR code, and a phone (no staff session — the token is its whole credential) opens
 * `/capture#<token>`, photographs the guest's ID and uploads through the token-gated route.
 * The upload lands in the same write-once store via the same service as the desk's own
 * capture, attributed to the operator who minted the token.
 */

export type PhoneCaptureToken = {
  token: string;
  /** ISO timestamp the token stops working (~15 min). */
  expiresAt: string;
  /** The backend machine's LAN IPv4 addresses — swapped in for localhost so the QR points
   *  somewhere a phone on the hotel Wi-Fi can actually reach. */
  lanIps: string[];
};

/** Mint the capture token — one party slot, or the WHOLE party with `allSlots: true`
 *  (the phone page then lists every guest and files each photo under the picked slot,
 *  server-validated). L1+ — desk side of the handoff. */
export async function mintPhoneCaptureToken(
  session: Session,
  entryId: string,
  body: { subjectKey?: string | null; subjectLabel?: string | null; allSlots?: boolean },
) {
  return apiRequest<PhoneCaptureToken>(`/api/entries/${entryId}/identity-proofs/phone-token`, {
    method: "POST",
    session,
    body,
  });
}

/** The room a guest is seated in per the S2 composition — server-derived with the same
 *  deterministic seating the desk table shows, so the two can't disagree. */
export type PhoneCaptureRoom = { roomNumber: string; bedType: string | null; roomTypeName: string | null };

/** One party member on the all-guests phone page: best label the desk holds (typed name or
 *  "Adult 2"), how many photos this booking already stores for them, and their room. */
export type PhoneCaptureRosterItem = { key: string; label: string; photoCount: number; room: PhoneCaptureRoom | null };

export type PhoneCaptureContext = {
  entryId: string;
  subjectKey: string | null;
  subjectLabel: string | null;
  sealed: boolean;
  /** Photos already stored — for the token's slot, or party-wide in all-guests mode. */
  uploadedCount: number;
  /** Present only on all-guests tokens: the whole party, one row per slot. */
  roster: PhoneCaptureRosterItem[] | null;
  /** The pinned guest's room on single-slot tokens (all-guests rows carry their own). */
  room: PhoneCaptureRoom | null;
  /** Config-driven document-type vocabulary for the phone's detected-fields form. */
  documentTypes?: IdentityDocumentTypeOption[];
};

/** What the phone page shows before the camera opens. Token-authenticated, no session. */
export async function fetchPhoneCaptureContext(token: string): Promise<PhoneCaptureContext> {
  const res = await fetch(`/api/identity-capture/context?token=${encodeURIComponent(token)}`);
  const data = (await res.json().catch(() => null)) as (PhoneCaptureContext & { message?: string }) | null;
  if (!res.ok) throw new Error(data?.message ?? `This link could not be checked (HTTP ${res.status})`);
  return data as PhoneCaptureContext;
}

/** Upload one photo from the phone — raw bytes body, token in the query. No session.
 *  `subjectKey` names the guest on all-guests tokens (single-slot tokens carry their own). */
export async function uploadPhoneCapture(
  token: string,
  file: File | Blob,
  fileName?: string,
  subjectKey?: string,
  /** The phone will post its own reading right after — the server pass waits for it. */
  extractionFollows?: boolean,
): Promise<{ id: string; subjectLabel: string | null; capturedAt: string }> {
  const params = new URLSearchParams({ token });
  if (fileName?.trim()) params.set("fileName", fileName.trim());
  if (subjectKey?.trim()) params.set("subjectKey", subjectKey.trim());
  if (extractionFollows) params.set("extractionFollows", "1");
  const res = await fetch(`/api/identity-capture/upload?${params}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let message = `Upload failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as { id: string; subjectLabel: string | null; capturedAt: string };
}

// ---------------------------------------------------------------------------------------
// OCR / QR extraction (2026-08-18) — suggestions the desk applies, never direct writes.
// ---------------------------------------------------------------------------------------

export type IdentitySuggestedFields = {
  documentType?: string;
  documentNumber?: string;
  documentNumberLast4?: string;
  fullName?: string;
  dateOfBirth?: string;
  gender?: string;
  nationality?: string;
  expiryDate?: string;
};
export type FieldConfidence = "VERIFIED" | "READ";
export type OcrEngine = "PHONE_QR" | "PHONE_MRZ" | "PHONE_MANUAL" | "SERVER_QR" | "SERVER_MRZ" | "SERVER_LAYOUT";
export type OcrSuggestionStatus = "PENDING" | "READY" | "EMPTY" | "FAILED" | "APPLIED" | "DISMISSED";

export type OcrSuggestion = {
  id: string;
  photoDocumentId: string;
  subjectKey: string | null;
  engine: OcrEngine;
  status: OcrSuggestionStatus;
  fields: IdentitySuggestedFields | null;
  fieldConfidence: Partial<Record<keyof IdentitySuggestedFields, FieldConfidence>> | null;
  source: string | null;
  error: string | null;
  extractedAt: string | null;
  appliedAt: string | null;
};

/** Desk: apply a suggestion (optionally with corrections) — writes through the detail save. */
export function applyOcrSuggestion(
  session: Session,
  suggestionId: string,
  overrides?: Partial<Pick<IdentitySuggestedFields, "documentType" | "documentNumber" | "fullName" | "dateOfBirth" | "gender">>,
) {
  return apiRequest<{ suggestion: OcrSuggestion; detail: unknown }>(`/api/identity-ocr-suggestions/${suggestionId}/apply`, {
    method: "POST",
    session,
    body: { overrides: overrides ?? null },
  });
}

export function dismissOcrSuggestion(session: Session, suggestionId: string) {
  return apiRequest<OcrSuggestion>(`/api/identity-ocr-suggestions/${suggestionId}/dismiss`, { method: "POST", session });
}

/** Desk: queue a fresh server-side read of one photo (W39). */
export function rerunPhotoOcr(session: Session, photoId: string) {
  return apiRequest<{ queued: boolean }>(`/api/identity-proofs/${photoId}/ocr`, { method: "POST", session });
}

export type PhoneParsePreview = {
  engine: OcrEngine | null;
  fields: IdentitySuggestedFields;
  fieldConfidence: Partial<Record<keyof IdentitySuggestedFields, FieldConfidence>>;
  raw: { mrzLines?: string[]; qrText?: string; source?: string } | null;
};

/** Phone: ask the server to interpret what the phone read (no storage) — the phone is a sensor. */
export async function parsePhoneReading(
  token: string,
  body: { ocrText?: string | null; qrText?: string | null; mrzLines?: string[] | null },
): Promise<PhoneParsePreview> {
  const res = await fetch(`/api/identity-capture/parse?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (PhoneParsePreview & { message?: string }) | null;
  if (!res.ok) throw new Error(data?.message ?? `Could not read the document (HTTP ${res.status})`);
  return data as PhoneParsePreview;
}

export type PhoneAnalyzeResult = {
  /** False when the server's OCR is switched off — the phone falls back to typing. */
  available: boolean;
  engine: OcrEngine | null;
  fields: IdentitySuggestedFields;
  fieldConfidence: Partial<Record<keyof IdentitySuggestedFields, FieldConfidence>>;
  source: string | null;
};

/**
 * Phone: hand the photo itself to the server's full reader (QR → MRZ → layout OCR) and get
 * the fields back — the pass that reads label documents (CID, work permit, birth
 * certificate) the phone can't read locally. Nothing is stored; slow (~10–20 s) is normal.
 */
export async function analyzePhoneCapture(token: string, file: Blob, subjectKey?: string): Promise<PhoneAnalyzeResult> {
  const params = new URLSearchParams({ token });
  if (subjectKey) params.set("subjectKey", subjectKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`/api/identity-capture/analyze?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "image/jpeg" },
      body: file,
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as (PhoneAnalyzeResult & { message?: string }) | null;
    if (!res.ok) throw new Error(data?.message ?? `Could not analyse the document (HTTP ${res.status})`);
    return data as PhoneAnalyzeResult;
  } finally {
    clearTimeout(timer);
  }
}

/** Phone: file the reading (raw payload + confirmed fields) against the uploaded photo. */
export async function sendPhoneExtraction(
  token: string,
  body: { photoDocumentId: string; mrzLines?: string[] | null; qrText?: string | null; fields?: IdentitySuggestedFields | null },
): Promise<{ id: string; status: OcrSuggestionStatus; engine: OcrEngine }> {
  const res = await fetch(`/api/identity-capture/extraction?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as ({ id: string; status: OcrSuggestionStatus; engine: OcrEngine } & { message?: string }) | null;
  if (!res.ok) throw new Error(data?.message ?? `Could not send the details (HTTP ${res.status})`);
  return data as { id: string; status: OcrSuggestionStatus; engine: OcrEngine };
}
