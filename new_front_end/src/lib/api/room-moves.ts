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
};

export type RoomMovePreviewLeg = {
  order: number;
  entryId: string;
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
