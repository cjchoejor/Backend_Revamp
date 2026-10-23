import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * HELD PAPERS (2026-10-12, operator ruling: "no paper goes to a guest unless the desk chooses").
 *
 * Every room-change walk re-confirms the booking, and the re-confirmation used to email the guest
 * the new voucher on its own — a room change, an extension or a seating repair mailed the guest
 * unasked. A walk now generates the paper and HOLDS it; this records the question the desk then
 * answers (send by email · mark sent on WhatsApp · don't send — `held-document-service.ts`).
 *
 * Kept in lib with no service imports so the walk can record a hold without an import cycle.
 */

export type HeldDocumentReason =
  | "ROOM_CHANGE"
  | "STAY_EXTENSION"
  | "SETUP_CHANGE"
  | "SEATING_REPAIR"
  | "REPRICE"
  | "ROOM_MOVE"
  | "DATE_MOVE"
  /** Rooms split off to a booking of their own (2026-10-14) — both bookings' papers. */
  | "ROOM_SPLIT";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Record a paper held for the desk. An older paper of the same kind on the booking that nobody
 * answered is marked SUPERSEDED — the newer one restates the stay, so sending the old would mislead.
 */
export async function recordHeldDocument(
  db: Db,
  input: {
    entryId: string;
    kind: "CONFIRMATION_VOUCHER" | "PROFORMA";
    documentId: string;
    reason: HeldDocumentReason;
    heldBy: string;
    heldByLevel?: string;
    roomMoveLegId?: string | null;
    stage?: string | null;
  },
) {
  const now = new Date();
  await db.heldDocument.updateMany({
    where: { entryId: input.entryId, kind: input.kind, decision: null },
    data: {
      decision: "SUPERSEDED",
      decidedAt: now,
      decidedBy: "SYSTEM",
      note: "A newer paper of the same kind replaced it before anyone decided",
    },
  });
  const row = await db.heldDocument.create({
    data: {
      entryId: input.entryId,
      kind: input.kind,
      documentId: input.documentId,
      reason: input.reason,
      roomMoveLegId: input.roomMoveLegId ?? null,
      heldBy: input.heldBy,
    },
  });
  await db.traceEvent
    .create({
      data: {
        eventType: "DOCUMENT.HELD",
        actorId: input.heldBy,
        actorLevel: (input.heldByLevel ?? "L1") as never,
        entityType: "HeldDocument",
        entityId: row.id,
        operation: "CREATE",
        timestamp: now,
        ...(input.stage ? { stageContext: input.stage as never } : {}),
        entryId: input.entryId,
        payload: {
          heldDocumentId: row.id,
          kind: input.kind,
          documentId: input.documentId,
          reason: input.reason,
          roomMoveLegId: input.roomMoveLegId ?? null,
        },
        createdBy: input.heldBy,
      },
    })
    .catch(() => {});
  return row;
}
