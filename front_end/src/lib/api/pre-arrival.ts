import type { EntryDetail } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type { HandoffChecklistItem } from "./handoffs";
export { getHandoffChecklist } from "./handoffs";

export async function activatePreArrival(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/activate-pre-arrival`, {
    method: "POST",
    session,
  });
}

/** S6 room change — re-enter S1 with a required reason; the new room is chosen fresh at S1. */
export async function s6RoomChangeReEnterS1(session: Session, entryId: string, reason: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/s6-room-change/re-enter-s1`, {
    method: "POST",
    session,
    body: { reason },
  });
}

export async function patchPreArrivalTask(
  session: Session,
  taskId: string,
  body: { action: "COMPLETE" | "WAIVE"; waivedReason?: string },
) {
  return apiRequest<unknown>(`/api/pre-arrival-tasks/${taskId}`, {
    method: "PATCH",
    session,
    body,
  });
}

export async function acceptHandoff(
  session: Session,
  handoffId: string,
  checklistCompletion?: Record<string, boolean>,
) {
  return apiRequest<unknown>(`/api/handoffs/${handoffId}/accept`, {
    method: "POST",
    session,
    body: { checklistCompletion: checklistCompletion ?? {} },
  });
}

/** H1 fulfilment payload required by p63-handoff-lifecycle-gates (SIG-S5 §6.2). */
export type H1FulfilmentEvidence = {
  roomAssignmentId: string;
  readinessConfirmed: boolean;
  paymentStatusConfirmed: boolean;
  ceilingProximityAddressed: boolean;
};

export function buildH1FulfilmentEvidence(input: H1FulfilmentEvidence): H1FulfilmentEvidence {
  return input;
}

export async function fulfilHandoff(
  session: Session,
  handoffId: string,
  fulfilmentEvidence: H1FulfilmentEvidence | Record<string, unknown>,
) {
  return apiRequest<unknown>(`/api/handoffs/${handoffId}/fulfil`, {
    method: "POST",
    session,
    body: { fulfilmentEvidence },
  });
}

export async function assignRoom(
  session: Session,
  entryId: string,
  body: {
    roomId: string;
    notes?: string;
    reEntryToS1?: boolean;
    deficientAcknowledgement?: {
      acknowledgementActorId: string;
      acknowledgementAt: string;
      decisionTaken: string;
    };
  },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/room-assignments`, {
    method: "POST",
    session,
    body,
  });
}

/**
 * Bulk-assign every room from the entry's sealed per-night AvailabilityConfiguration. Used for
 * multi-room bookings (Entry.numberOfRooms > 1): the backend reads `optionSelected.perNight`
 * and creates one RoomAssignment per contiguous (room, date-range) slice — folding same-room
 * nights into a single full-range assignment and representing mid-stay room changes as separate
 * date-scoped rows. Idempotent on retry.
 */
export async function assignRoomsFromSealedPerNight(session: Session, entryId: string) {
  return apiRequest<{
    assignments: Array<{ id: string; roomId: string; startDate: string; endDate: string }>;
    count: number;
  }>(`/api/entries/${entryId}/room-assignments/from-sealed-per-night`, {
    method: "POST",
    session,
  });
}

export async function acknowledgeCreditCeilingTier2(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/credit-ceiling-tier2-ack`, {
    method: "POST",
    session,
  });
}
