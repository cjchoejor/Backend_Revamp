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

/**
 * Re-send the confirmation voucher to the guest (2026-08-07): fresh tracked communication +
 * reply window, same email body + PDF attachment the confirmation sent. `dispatchedTo`
 * overrides the guest profile's email (corrected address).
 */
export async function resendConfirmationVoucher(
  session: Session,
  reservationId: string,
  body?: { dispatchedTo?: string },
) {
  return apiRequest<{ communicationRecordId: string; dispatchedTo: string }>(
    `/api/reservations/${reservationId}/confirmation-voucher/send`,
    { method: "POST", session, body: body ?? {} },
  );
}

export type ConfirmProgressResult = EntryDetail;
