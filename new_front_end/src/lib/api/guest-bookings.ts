import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * The same guest's other bookings, and combining two of them while both are at Inquiry or
 * Negotiation (2026-10-19). Matched on the guest record, never the name. Every rule and refusal is
 * the server's; the desk only shows them.
 */

export type SameGuestBooking = {
  entryId: string;
  inquiryId: string;
  sameEnquiry: boolean;
  stage: string;
  stageWord: string;
  status: string;
  closedAs: string | null;
  live: boolean;
  checkInDate: string | null;
  checkOutDate: string | null;
  rooms: string[];
  /** Live, and its nights overlap this booking's. */
  overlapsThis: boolean;
  combine: { possible: boolean; why: string | null };
};

export type SameGuestBookings = {
  guestProfileId: string | null;
  guestName: string | null;
  bookings: SameGuestBooking[];
  /**
   * The guest's other RESERVED booking over these nights — what Reserve asks the FOM to
   * acknowledge (Policy 13), read the gate's own way; null when there is none (2026-10-29).
   */
  reserveOverlap: {
    entryId: string;
    checkInDate: string;
    checkOutDate: string;
    /** SAME_GUEST — the same guest record; SAME_NAME — the same name through the same agency or company (2026-11-24). */
    why?: "SAME_GUEST" | "SAME_NAME";
    partyName?: string | null;
    acknowledged: boolean;
  } | null;
};

/** "Is this the same booking entered twice?" — an open question and the other booking (2026-11-24). */
export type DuplicateQuestion = {
  flagId: string;
  raisedAt: string;
  other: {
    entryId: string;
    inquiryId: string;
    guestName: string;
    checkInDate: string;
    checkOutDate: string;
    stageWord: string;
    parked: boolean;
    /** SAME_GUEST — the same guest record; SAME_NAME — the same name through the same agency or company. */
    why: "SAME_GUEST" | "SAME_NAME";
    partyName: string | null;
  } | null;
};

export async function getDuplicateCheck(session: Session, entryId: string) {
  return apiRequest<{ questions: DuplicateQuestion[] }>(`/api/entries/${entryId}/duplicate-check`, { session });
}

/** "Both are meant" — not the same booking twice; the booking may move on. */
export async function answerBothMeant(session: Session, entryId: string, flagId: string, note?: string | null) {
  return apiRequest<{ flagId: string; status: string; reason: string }>(`/api/entries/${entryId}/duplicate-check/${flagId}/both-meant`, {
    method: "POST",
    session,
    body: { note: note ?? null },
  });
}

export type CombinePreview = {
  ok: boolean;
  refusals: string[];
  authority: { needed: "L1" | "L2"; ok: boolean; why: string };
  kept: { entryId: string; stageWord: string; adults: number; children: number; rooms: string[] };
  other: { entryId: string; stageWord: string; adults: number; children: number; rooms: string[]; notes: number; openRequests: number; holdsBlock: boolean };
  after: {
    adults: number;
    children: number;
    childAges: number[];
    numberOfRooms: number;
    nights: Array<{ date: string; rooms: string[] }>;
    bedTypeRequest: Record<string, number> | null;
  };
  consequences: string[];
};

export type CombineOutcome = {
  entryId: string;
  combinedFrom: string;
  stage: string;
  rooms: string[];
  adults: number;
  children: number;
  otherEnded: boolean;
  otherEndRefused: string | null;
  flagsResolved: string[];
  notes: string[];
};

export async function listSameGuestBookings(session: Session, entryId: string) {
  return apiRequest<SameGuestBookings>(`/api/entries/${entryId}/guest-bookings`, { session });
}

export async function previewCombineBookings(session: Session, entryId: string, otherEntryId: string) {
  return apiRequest<CombinePreview>(`/api/entries/${entryId}/combine/preview`, { method: "POST", session, body: { otherEntryId } });
}

export async function combineBookings(session: Session, entryId: string, body: { otherEntryId: string; reason: string; expectedVersion?: number }) {
  return apiRequest<CombineOutcome>(`/api/entries/${entryId}/combine`, { method: "POST", session, body });
}
