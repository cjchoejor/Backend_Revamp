import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { authHeaders, openPdf } from "./documents";

/**
 * A trip's quotation (2026-11-07): each stay keeps its own quotation, and the trip has one made of
 * them, with its own number and versions — `GET/POST /api/entries/:id/trip-quotation`.
 */
export type TripQuotation = {
  inquiryId: string;
  stays: Array<{
    stayNo: number;
    entryId: string;
    stage: string;
    checkIn: string | null;
    checkOut: string | null;
    quotation: { id: string; number: string; state: string; total: string } | null;
  }>;
  /** The stays' quotations added up, by the server. */
  total: string | null;
  canMake: boolean;
  reason: string | null;
  current: {
    id: string;
    number: string;
    versionNumber: number;
    total: string;
    validUntil: string | null;
    sentAt: string | null;
    sentTo: string | null;
    sentChannel: string | null;
    answeredAt: string | null;
    upToDate: boolean;
    members: Array<{ entryId: string; stayNo: number; paperId: string; number: string; total: string; checkIn: string | null; checkOut: string | null }>;
  } | null;
  versions: Array<{ id: string; number: string; state: string; total: string; createdAt: string; sentAt: string | null }>;
};

export function getTripQuotation(session: Session, entryId: string) {
  return apiRequest<TripQuotation>(`/api/entries/${entryId}/trip-quotation`, { session });
}

export function makeTripQuotation(session: Session, entryId: string) {
  return apiRequest<{ made: boolean; id: string }>(`/api/entries/${entryId}/trip-quotation`, { method: "POST", session, body: {} });
}

export function sendTripQuotation(session: Session, tripPaperId: string, body: { channel: "EMAIL" | "WHATSAPP"; to?: string | null; nightsEach?: boolean }) {
  return apiRequest<{ sentTo: string | null; channel: string; number: string }>(`/api/trip-papers/${tripPaperId}/send`, { method: "POST", session, body });
}

export function answerTripQuotation(session: Session, tripPaperId: string, body: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string | null }) {
  return apiRequest<{ recorded: number }>(`/api/trip-papers/${tripPaperId}/answer`, { method: "POST", session, body });
}

function face(opts?: { hidePrices?: boolean; nightsEach?: boolean }) {
  const q = new URLSearchParams();
  if (opts?.hidePrices) q.set("prices", "none");
  if (opts?.nightsEach) q.set("nights", "each");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchTripPaperPreviewHtml(session: Session, id: string, opts?: { hidePrices?: boolean; nightsEach?: boolean }): Promise<string> {
  const res = await fetch(`/api/trip-papers/${id}/preview-html${face(opts)}`, { headers: authHeaders(session), credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not load the trip's quotation (HTTP ${res.status})`);
  return res.text();
}

export function openTripPaperPdf(session: Session, id: string, opts?: { hidePrices?: boolean; nightsEach?: boolean }): Promise<void> {
  return openPdf(session, `/api/trip-papers/${id}/pdf${face(opts)}`);
}
