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

/** Upsert one party member's typed details (passport/permit no, name, DOB, gender). */
export async function saveGuestIdentityDetail(
  session: Session,
  entryId: string,
  body: {
    subjectKey: string;
    subjectLabel?: string | null;
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
 *  (`entryId` says which booking each was taken on). */
export async function listIdentityProofs(session: Session, entryId: string) {
  return apiRequest<{ items: IdentityProofSummary[] }>(`/api/entries/${entryId}/identity-proofs`, { session });
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
