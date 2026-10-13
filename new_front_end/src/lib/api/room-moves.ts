import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Room moves from the house chart, and the papers every room-change walk holds for the desk
 * (2026-10-12). Every figure, refusal and path is the server's; the desk only shows them.
 */

export type RoomMoveLegInput = {
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  priceMode?: "KEEP" | "NEW_TYPE";
  guestAgreedNote?: string | null;
  /** On a leg the server added (a booking swapped into the room left behind), sent back as it came. */
  displacedBy?: string | null;
};

export type RoomMovePreviewLeg = {
  order: number;
  /** `entryId|fromRoomId` — a booking can move several of its rooms in one move. */
  key: string;
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  bookingLabel: string;
  guestName: string | null;
  stage: string;
  stageWord: string;
  fromRoom: { roomId: string; roomNumber: string; roomTypeName: string | null } | null;
  toRoom: { roomId: string; roomNumber: string; roomTypeName: string | null } | null;
  nights: string[];
  nightsLabel: string | null;
  sameType: boolean | null;
  priceMode: "KEEP" | "NEW_TYPE";
  guestAgreedNote: string | null;
  /** Added by the server: this booking sits in a room another leg moves into. */
  displaced: boolean;
  /** The booking whose move made this one. */
  displacedBy: string | null;
  pricing: { before: number | null; after: number | null; delta: number | null; currency: string | null; note: string | null };
  path: string[];
  papers: string[];
  followUps: string[];
  refusals: string[];
};

export type RoomMovePreview = {
  kind: "MOVE" | "SWAP";
  ok: boolean;
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; why: string };
  legs: RoomMovePreviewLeg[];
  /** Refusals that belong to the move as a whole, not to one booking. */
  refusals: string[];
};

export type RoomMoveLeg = {
  id: string;
  order: number;
  entryId: string;
  guestName: string | null;
  currentStage: string;
  fromRoomId: string;
  fromRoomNumber: string;
  toRoomId: string;
  toRoomNumber: string;
  nights: string[];
  nightsLabel: string | null;
  originStage: string;
  priceMode: "KEEP" | "NEW_TYPE";
  guestAgreedNote: string | null;
  status: "PLANNED" | "DONE" | "STOPPED" | "REFUSED" | "REVERTED" | "CANCELLED";
  compensates: string | null;
  refusal: { message: string; code: string | null } | null;
  newSegmentNumber: number | null;
  reachedStage: string | null;
  blocked: { atStep: string; code: string | null; message: string } | null;
  pricing: { priorTotal: number | null; newTotal: number | null; delta: number | null; currency: string | null } | null;
  quotationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  heldDocuments: Array<{ id: string; kind: "CONFIRMATION_VOUCHER" | "PROFORMA"; documentId: string; decision: string | null; sentTo: string | null; decidedAt: string | null }>;
};

export type RoomMove = {
  id: string;
  kind: "MOVE" | "SWAP";
  status: "IN_PROGRESS" | "COMPLETED" | "PARTIAL" | "REVERTED" | "FAILED";
  reason: string;
  requestedBy: string;
  requestedLevel: string;
  createdAt: string;
  completedAt: string | null;
  notes: unknown[];
  legs: RoomMoveLeg[];
};

export async function previewRoomMove(session: Session, body: { legs: RoomMoveLegInput[]; reason?: string | null }) {
  return apiRequest<RoomMovePreview>(`/api/room-moves/preview`, { method: "POST", session, body });
}

export async function executeRoomMove(session: Session, body: { legs: RoomMoveLegInput[]; reason: string }) {
  return apiRequest<RoomMove>(`/api/room-moves`, { method: "POST", session, body });
}

export async function getRoomMove(session: Session, moveId: string) {
  return apiRequest<RoomMove>(`/api/room-moves/${moveId}`, { session });
}

export async function listRoomMovesForEntry(session: Session, entryId: string) {
  return apiRequest<RoomMove[]>(`/api/entries/${entryId}/room-moves`, { session });
}

export async function retryRoomMoveLeg(session: Session, moveId: string, legId: string, reason?: string) {
  return apiRequest<RoomMove>(`/api/room-moves/${moveId}/legs/${legId}/retry`, { method: "POST", session, body: reason ? { reason } : {} });
}

export async function resolveRoomMove(session: Session, moveId: string, note: string) {
  return apiRequest<RoomMove>(`/api/room-moves/${moveId}/resolve`, { method: "POST", session, body: { note } });
}

export type HeldDocument = {
  id: string;
  entryId: string;
  kind: "CONFIRMATION_VOUCHER" | "PROFORMA";
  documentId: string;
  /** The number printed on the paper — VOU-… for a voucher, INV-… for a bill. */
  documentNumber?: string;
  reason: string;
  roomMoveLegId: string | null;
  heldAt: string;
  heldBy: string;
  decision: "SENT_EMAIL" | "SENT_WHATSAPP" | "NOT_SENT" | "SUPERSEDED" | null;
  sentTo: string | null;
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  defaultRecipient: { to: string | null; whose: string | null };
};

export async function listHeldDocuments(session: Session, entryId: string) {
  return apiRequest<HeldDocument[]>(`/api/entries/${entryId}/held-documents`, { session });
}

export async function decideHeldDocument(
  session: Session,
  heldDocumentId: string,
  body: { action: "EMAIL" | "WHATSAPP" | "NONE"; sentTo?: string | null; note?: string | null },
) {
  return apiRequest<HeldDocument>(`/api/held-documents/${heldDocumentId}/decide`, { method: "POST", session, body });
}

/* ── Moving a booking to other dates from the house chart (2026-10-13) ───────────────────── */

export type DateMoveInput = {
  entryId: string;
  /** The room whose bar was dragged. */
  fromRoomId: string;
  /** Where that room lands, when the drag also changed its row (one room). */
  toRoomId?: string | null;
  /** Every room that changes row, old → new — the booking moves as a block (2026-10-13). */
  roomMap?: Record<string, string> | null;
  /** The new first night, "YYYY-MM-DD" — the stay keeps its number of nights. */
  newCheckInDate: string;
  /** The price choice for a room not named in `priceModes`. */
  priceMode?: "KEEP" | "NEW_DATES";
  /** The price choice per room, keyed by the room as it is now. */
  priceModes?: Record<string, "KEEP" | "NEW_DATES"> | null;
  guestAgreedNote?: string | null;
};

export type DateMovePreview = {
  ok: boolean;
  entryId: string;
  bookingLabel: string;
  guestName: string | null;
  stage: string;
  stageWord: string;
  route: "NEGOTIATION" | "WALK";
  from: { checkInDate: string; checkOutDate: string; nights: number };
  to: { checkInDate: string; checkOutDate: string; nights: number };
  shiftDays: number;
  rooms: Array<{
    roomId: string;
    roomNumber: string;
    toRoomId: string | null;
    toRoomNumber: string | null;
    nightsLabel: string;
    sameType: boolean;
    priceMode: "KEEP" | "NEW_DATES";
    /** This room's total on the new nights, tax included, before any booking discount — for each choice. */
    keepTotal: number | null;
    newDatesTotal: number | null;
  }>;
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; waitsForApproval: boolean; why: string };
  price: { before: number | null; after: number | null; delta: number | null; currency: string | null; note: string | null };
  path: string[];
  papers: string[];
  notes: string[];
  refusals: string[];
};

export type DateMoveResult =
  | {
      route: "WALK";
      entryId: string;
      outcome: {
        newSegmentNumber: number;
        pricing: { priorTotal: number | null; newTotal: number | null; delta: number | null; currency: string | null };
        walk: { returnedToOrigin: boolean; reachedStage: string; blocked: { atStep: string; code: string | null; message: string } | null };
        dateShift: { newCheckInDate: string; newCheckOutDate: string; arrivalOpensOn: string | null } | null;
        heldDocuments: Array<{ id: string; kind: "CONFIRMATION_VOUCHER" | "PROFORMA"; documentId: string }>;
      };
    }
  | {
      route: "NEGOTIATION";
      entryId: string;
      outcome: {
        applied: boolean;
        requestId?: string;
        datesChanged: boolean;
        newDates: { checkInDate: string | null; checkOutDate: string | null };
        quotationsInvalidated: Array<{ id: string; referenceNumber: string }>;
      };
    };

export async function previewDateMove(session: Session, body: DateMoveInput & { reason?: string | null }) {
  return apiRequest<DateMovePreview>(`/api/date-moves/preview`, { method: "POST", session, body });
}

export async function executeDateMove(session: Session, body: DateMoveInput & { reason: string }) {
  return apiRequest<DateMoveResult>(`/api/date-moves`, { method: "POST", session, body });
}
