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

export function sendTripQuotation(
  session: Session,
  tripPaperId: string,
  body: { channel: "EMAIL" | "WHATSAPP"; to?: string | null; nightsEach?: boolean; showRoomTypes?: boolean },
) {
  return apiRequest<{ sentTo: string | null; channel: string; number: string }>(`/api/trip-papers/${tripPaperId}/send`, { method: "POST", session, body });
}

export function answerTripQuotation(session: Session, tripPaperId: string, body: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string | null }) {
  return apiRequest<{ recorded: number }>(`/api/trip-papers/${tripPaperId}/answer`, { method: "POST", session, body });
}

type TripFace = { hidePrices?: boolean; nightsEach?: boolean; roomTypes?: "hidden" | "shown" };
function face(opts?: TripFace) {
  const q = new URLSearchParams();
  if (opts?.hidePrices) q.set("prices", "none");
  if (opts?.nightsEach) q.set("nights", "each");
  if (opts?.roomTypes) q.set("roomTypes", opts.roomTypes);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchTripPaperPreviewHtml(session: Session, id: string, opts?: TripFace): Promise<string> {
  const res = await fetch(`/api/trip-papers/${id}/preview-html${face(opts)}`, { headers: authHeaders(session), credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not load the trip's quotation (HTTP ${res.status})`);
  return res.text();
}

export function openTripPaperPdf(session: Session, id: string, opts?: TripFace): Promise<void> {
  return openPdf(session, `/api/trip-papers/${id}/pdf${face(opts)}`);
}

/** Either trip paper is sent and answered by its own id. */
export const sendTripPaper = sendTripQuotation;
export const answerTripPaper = answerTripQuotation;

/**
 * A trip's proforma (2026-11-07): each stay keeps its own proforma and the trip has one made of
 * them — `GET/POST /api/entries/:id/trip-proforma`. Every figure is the server's.
 */
export type TripProforma = {
  inquiryId: string;
  stays: Array<{
    stayNo: number;
    entryId: string;
    stage: string;
    checkIn: string | null;
    checkOut: string | null;
    proforma: { id: string; number: string; sent: boolean; lapsed: boolean; total: string; advanceAsked: string | null; received: string; dueNow: string } | null;
  }>;
  total: string | null;
  advanceAsked: string | null;
  received: string;
  dueNow: string | null;
  canMake: boolean;
  reason: string | null;
  current: TripQuotation["current"];
  versions: TripQuotation["versions"];
};

export function getTripProforma(session: Session, entryId: string) {
  return apiRequest<TripProforma>(`/api/entries/${entryId}/trip-proforma`, { session });
}

export function makeTripProforma(session: Session, entryId: string) {
  return apiRequest<{ made: boolean; id: string }>(`/api/entries/${entryId}/trip-proforma`, { method: "POST", session, body: {} });
}

export type TripPaymentShare = { entryId: string; amount: number };

/** How a payment for the trip would be shared, and what is wrong with it — the server's figures. */
export type TripPaymentPreview = {
  mode: "FIRST_STAY_FIRST" | "AS_TYPED";
  problem: string | null;
  sharesTotal: string;
  stays: Array<{ stayNo: number; entryId: string; number: string | null; dueNow: string; canTake: string; overAsked?: string; share: string }>;
  tripDueNow: string;
  tripCanTake: string;
};

export function previewTripPayment(session: Session, tripPaperId: string, body: { amount?: number | null; shares?: TripPaymentShare[] | null }) {
  return apiRequest<TripPaymentPreview>(`/api/trip-papers/${tripPaperId}/payment/preview`, { method: "POST", session, body });
}

export function recordTripPayment(
  session: Session,
  tripPaperId: string,
  body: { amount: number; paymentMethod?: string; bankName?: string; journalNumber?: string; notes?: string; shares?: TripPaymentShare[] | null },
) {
  return apiRequest<{
    amount: string;
    mode: "FIRST_STAY_FIRST" | "AS_TYPED";
    shares: Array<{ stayNo: number; entryId: string; amount: string; paymentId: string }>;
  }>(`/api/trip-papers/${tripPaperId}/payment`, { method: "POST", session, body });
}

/** A trip's stays as a payment sees them (2026-11-07) — by the booking, with or without a trip proforma. */
export type TripPaymentStay = {
  stayNo: number;
  entryId: string;
  stage: string;
  checkIn: string | null;
  checkOut: string | null;
  number: string | null;
  payable: boolean;
  why: string | null;
  advanceAsked: string | null;
  received: string;
  dueNow: string;
  canTake: string;
  share?: string;
  /** How far the share is from the advance still asked: + more, - less. */
  overAsked?: string;
};

export type TripPaymentStanding = {
  inquiryId: string;
  tripPaper: { id: string; number: string } | null;
  stays: TripPaymentStay[];
  received: string;
  dueNow: string;
  canTake: string;
};

export function getTripPayment(session: Session, entryId: string) {
  return apiRequest<TripPaymentStanding>(`/api/entries/${entryId}/trip-payment`, { session });
}

export function previewTripPaymentForEntry(session: Session, entryId: string, body: { amount?: number | null; shares?: TripPaymentShare[] | null }) {
  return apiRequest<Omit<TripPaymentPreview, "stays"> & { stays: TripPaymentStay[] }>(`/api/entries/${entryId}/trip-payment/preview`, { method: "POST", session, body });
}

export function recordTripPaymentForEntry(
  session: Session,
  entryId: string,
  body: { amount: number; paymentMethod?: string; bankName?: string; journalNumber?: string; notes?: string; shares?: TripPaymentShare[] | null },
) {
  return apiRequest<Awaited<ReturnType<typeof recordTripPayment>>>(`/api/entries/${entryId}/trip-payment`, { method: "POST", session, body });
}

/** A trip's confirmation voucher (2026-11-09): made of the stays' own once every stay is reserved. */
export type TripVoucher = {
  inquiryId: string;
  stays: Array<{
    stayNo: number;
    entryId: string;
    stage: string;
    checkIn: string | null;
    checkOut: string | null;
    voucher: { reservationId: string; number: string; held: boolean; decision: string | null } | null;
  }>;
  canMake: boolean;
  reason: string | null;
  current: {
    id: string;
    number: string;
    versionNumber: number;
    sentAt: string | null;
    sentTo: string | null;
    sentChannel: string | null;
    notSent: boolean;
    answeredAt: string | null;
    upToDate: boolean;
  } | null;
  versions: Array<{ id: string; number: string; state: string; createdAt: string; sentAt: string | null }>;
};

export function getTripVoucher(session: Session, entryId: string) {
  return apiRequest<TripVoucher>(`/api/entries/${entryId}/trip-voucher`, { session });
}

export function markTripVoucherNotSent(session: Session, tripPaperId: string, body: { note?: string | null }) {
  return apiRequest<{ number: string }>(`/api/trip-papers/${tripPaperId}/not-sent`, { method: "POST", session, body });
}
