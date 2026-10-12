import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/* ---- Notes and to-dos (the Notes tab, 2026-10-12) ---- */

export const NOTE_ASSIGNEES = [
  ["DESK", "Desk"],
  ["FOM", "FOM"],
  ["HOUSEKEEPING", "Housekeeping"],
  ["KITCHEN", "Kitchen"],
  ["MAINTENANCE", "Maintenance"],
] as const;
export type NoteAssignee = (typeof NOTE_ASSIGNEES)[number][0];

export type BookingNote = {
  id: string;
  kind: "NOTE" | "TODO";
  text: string;
  assignee: NoteAssignee | null;
  dueAt: string | null;
  doneAt: string | null;
  doneByName: string | null;
  overdue: boolean;
  stageContext: string | null;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  editedAt: string | null;
  editedByName: string | null;
  priorTexts: Array<{ text: string; at: string; by: string; byName: string | null }>;
};

export type BookingNotes = {
  items: BookingNote[];
  counts: { notes: number; openTodos: number; overdueTodos: number };
};

export function listBookingNotes(session: Session, entryId: string) {
  return apiRequest<BookingNotes>(`/api/entries/${entryId}/notes`, { session });
}

export type AddBookingNoteBody =
  | { kind: "NOTE"; text: string }
  | {
      kind: "TODO";
      text: string;
      assignee: NoteAssignee;
      /** An instant ("within the hour") … */
      dueAt?: string | null;
      /** … or the hotel's wall clock, sent as it reads ("2026-10-12", "18:00"). */
      dueDate?: string | null;
      dueTime?: string | null;
    };

export function addBookingNote(session: Session, entryId: string, body: AddBookingNoteBody) {
  return apiRequest<{ id: string }>(`/api/entries/${entryId}/notes`, { method: "POST", session, body });
}

export function editBookingNote(session: Session, noteId: string, text: string) {
  return apiRequest<{ id: string }>(`/api/booking-notes/${noteId}/edit`, { method: "POST", session, body: { text } });
}

export function setBookingTodoDone(session: Session, noteId: string, done: boolean) {
  return apiRequest<{ id: string }>(`/api/booking-notes/${noteId}/done`, { method: "POST", session, body: { done } });
}

/* ---- Guest requests (BE-64, the Guest requests tab) ---- */

export type GuestRequest = {
  id: string;
  kind: string;
  what: string;
  forDate: string | null;
  forTime: string | null;
  state: "ASKED" | "ARRANGED" | "WITHDRAWN";
  stageContext: string | null;
  createdAt: string;
  createdByName: string | null;
  arrangedAt: string | null;
  arrangedByName: string | null;
  arrangedNote: string | null;
  withdrawnAt: string | null;
  withdrawnByName: string | null;
  withdrawnReason: string | null;
};

export type GuestRequests = {
  items: GuestRequest[];
  kinds: string[];
  /** The guest's standing preference — the enquiry's preference line. */
  preference: string | null;
  stay: { checkInDate: string | null; checkOutDate: string | null };
  counts: { open: number; total: number };
};

export function listGuestRequests(session: Session, entryId: string) {
  return apiRequest<GuestRequests>(`/api/entries/${entryId}/guest-requests`, { session });
}

export function addGuestRequest(
  session: Session,
  entryId: string,
  body: { kind: string; what: string; forDate?: string | null; forTime?: string | null },
) {
  return apiRequest<{ id: string }>(`/api/entries/${entryId}/guest-requests`, { method: "POST", session, body });
}

export function arrangeGuestRequest(session: Session, requestId: string, note?: string | null) {
  return apiRequest<{ id: string }>(`/api/guest-requests/${requestId}/arranged`, { method: "POST", session, body: { note: note ?? null } });
}

export function withdrawGuestRequest(session: Session, requestId: string, reason: string) {
  return apiRequest<{ id: string }>(`/api/guest-requests/${requestId}/withdraw`, { method: "POST", session, body: { reason } });
}
