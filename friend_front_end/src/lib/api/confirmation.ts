import type { EntryDetail } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { normalizeEntryResponse } from "./entries";

export async function confirmReservation(session: Session, entryId: string, version: number) {
  const data = await apiRequest<unknown>(`/api/entries/${entryId}/confirm`, {
    method: "POST",
    session,
    body: { version },
  });
  return normalizeEntryResponse(data);
}

export async function acknowledgeMultiBooking(session: Session, entryId: string, note?: string) {
  return apiRequest<{ ok: boolean }>(`/api/entries/${entryId}/multi-booking/ack`, {
    method: "POST",
    session,
    body: { note },
  });
}

export async function verifyConference(session: Session, entryId: string, checklist?: unknown) {
  return apiRequest<{ ok: boolean }>(`/api/entries/${entryId}/conference/verify`, {
    method: "POST",
    session,
    body: { checklist },
  });
}

export type ConfirmProgressResult = EntryDetail;
