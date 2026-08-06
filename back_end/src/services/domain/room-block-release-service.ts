/**
 * Release a room's out-of-service block, on a GM's authority, from the operational surface.
 *
 * Blocking a room is inventory configuration and lives in the L4 admin console
 * (`inventoryAdminService.deactivateRoom` / `reactivateRoom`). Unblocking one, though, is a
 * decision the front desk hits in the middle of a booking: a guest is standing there, a room is
 * flagged out of service, and the only person who could clear it was an admin who may not be on
 * shift. This is the operational counterpart — same effect on the room, GM authority, a reason
 * recorded, and its own trace event so it reads differently from an admin reactivation.
 *
 * A block has no expiry. `Room` carries `isBlocked` / `blockedReason` and no unblock date, and
 * W32 (BlockedRoomUnblockWorker) is a stub that is not registered — so unlike a hold, a block
 * never clears itself and a person must always decide. That is exactly why this exists.
 */
import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * GM and above, matching the bar for releasing another booking's committed hold.
 *
 * A block usually means the room is genuinely not fit to sell — maintenance, damage, a deep
 * clean. Clearing it says the opposite, and if that judgement is wrong the guest walks into the
 * problem the block existed to prevent. That belongs above the operator who needs the room.
 */
function enforceRoomBlockReleaseAuthority(actorLevel: "L1" | "L2" | "L3" | "L4") {
  if (actorLevel === "L3" || actorLevel === "L4") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L3", "GM authority required to release a room block");
}

export async function releaseRoomBlock(
  prisma: PrismaClient,
  roomId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { releaseReason: string },
) {
  enforceRoomBlockReleaseAuthority(actor.actorLevel);
  const reason = input.releaseReason?.trim();
  if (!reason) {
    throw new ValidationError("releaseReason is required — it is recorded against the room being put back in service");
  }

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new NotFoundError("Room");
  if (!room.isBlocked) throw new ValidationError("That room is not blocked");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.room.update({
      where: { id: roomId },
      // The prior reason is kept in the trace below, not on the room — the room is back in
      // service and carrying a stale "why it was blocked" string would misread as still blocked.
      data: { isBlocked: false, blockedReason: null, updatedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ROOM.BLOCK_RELEASED_BY_AUTHORITY",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Room",
        entityId: roomId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S1,
        payload: {
          roomId,
          roomNumber: updated.roomNumber,
          priorBlockedReason: room.blockedReason,
          reason,
        },
        createdBy: actor.actorId,
      },
    });
    return updated;
  });
}
