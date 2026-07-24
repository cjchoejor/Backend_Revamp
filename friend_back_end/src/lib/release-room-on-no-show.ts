import type { Prisma } from "@prisma/client";
import { HoldState, InventoryClaimState } from "@prisma/client";

type CommittedHoldLike = { id: string; state: HoldState; roomId: string | null } | null | undefined;

/**
 * SIG-S5 §1.5 (no-show #5) / §3.5 — when an entry is closed via no-show determination, the room
 * held for it must be returned to available inventory: Room.currentClaimState → FREE with a
 * RoomClaimStateEvent (reason NO_SHOW_RELEASE), and the committed hold marked RELEASED. Mirrors the
 * S5 pre-arrival cancellation release path in cancellation-service.ts. Idempotent: no-ops when the
 * hold is absent/already released or the room is already FREE. Call INSIDE the same transaction that
 * closes the folio and transitions the entry to TERMINAL.
 */
export async function releaseRoomOnNoShowTerminalTx(
  tx: Prisma.TransactionClient,
  args: { entryId: string; committedHold: CommittedHoldLike; actorId: string; now: Date },
): Promise<{ released: boolean; roomId: string | null }> {
  const { entryId, committedHold, actorId, now } = args;
  if (!committedHold) return { released: false, roomId: null };
  if (committedHold.state === HoldState.RELEASED || committedHold.state === HoldState.EXPIRED) {
    return { released: false, roomId: committedHold.roomId ?? null };
  }

  let released = false;
  if (committedHold.roomId) {
    const room = await tx.room.findUnique({ where: { id: committedHold.roomId } });
    const fromState = room?.currentClaimState;
    if (fromState && fromState !== InventoryClaimState.FREE) {
      await tx.room.update({
        where: { id: committedHold.roomId },
        data: { currentClaimState: InventoryClaimState.FREE },
      });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: committedHold.roomId,
          entryId,
          fromState,
          toState: InventoryClaimState.FREE,
          actorId,
          reason: "NO_SHOW_RELEASE",
          effectiveFrom: now,
        },
      });
      released = true;
    }
  }

  await tx.committedHold.update({
    where: { id: committedHold.id },
    data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: actorId, releaseReason: "NO_SHOW_RELEASE" },
  });

  return { released, roomId: committedHold.roomId ?? null };
}
