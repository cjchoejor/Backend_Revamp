/**
 * One-shot data-repair: reset rooms whose currentClaimState is stale
 * (no live reservation or committed hold covering "now") back to FREE.
 *
 * Discovered 2026-07-25 while debugging why room 201 rejected a committed hold
 * despite the availability engine showing it free — Room.currentClaimState was
 * OCCUPIED from a June entry whose S8 physical-departure never released the
 * claim state.
 *
 * Dry run by default. Pass --commit to apply.
 *
 * A room is "live-claimed" if:
 *   - It has a Reservation whose frozenCheckInDate <= now < frozenCheckOutDate, OR
 *   - It has a CommittedHold (PLACED/CONFIRMED) whose expiresAt > now
 * Anything else is stale.
 *
 * Blocked / under-maintenance rooms are left alone (their state has its own owner).
 */
import { prisma } from "../src/db.js";
import { InventoryClaimState } from "@prisma/client";

async function main() {
  const commit = process.argv.includes("--commit");
  const now = new Date();

  const rooms = await prisma.room.findMany({
    where: {
      currentClaimState: { not: InventoryClaimState.FREE },
      isBlocked: false,
      isUnderMaintenance: false,
    },
    select: { id: true, roomNumber: true, currentClaimState: true },
    orderBy: { roomNumber: "asc" },
  });

  const stuck: Array<{ id: string; roomNumber: string; fromState: InventoryClaimState }> = [];

  for (const room of rooms) {
    const liveReservation = await prisma.reservation.findFirst({
      where: {
        frozenCheckInDate: { lte: now },
        frozenCheckOutDate: { gt: now },
        entry: { roomAssignments: { some: { roomId: room.id } } },
      },
      select: { entryId: true },
    });
    const liveHold = await prisma.committedHold.findFirst({
      where: {
        roomId: room.id,
        state: { in: ["PLACED", "CONFIRMED"] },
        expiresAt: { gt: now },
      },
      select: { entryId: true },
    });
    if (liveReservation || liveHold) {
      console.log(`[keep] room=${room.roomNumber} state=${room.currentClaimState} — has a live claim`);
      continue;
    }
    stuck.push({ id: room.id, roomNumber: room.roomNumber, fromState: room.currentClaimState });
  }

  console.log(`\n=== ${stuck.length} rooms to reset to FREE ===`);
  for (const s of stuck) console.log(`  ${s.roomNumber}: ${s.fromState} → FREE`);

  if (!commit) {
    console.log("\n(dry run — pass --commit to apply)");
    await prisma.$disconnect();
    return;
  }

  const REPAIR_ACTOR = "SYSTEM_REPAIR";
  const reason = "Stale claim state cleanup 2026-07-25: no live reservation or hold covered this room";

  await prisma.$transaction(async (tx) => {
    for (const s of stuck) {
      await tx.room.update({
        where: { id: s.id },
        data: { currentClaimState: InventoryClaimState.FREE },
      });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: s.id,
          fromState: s.fromState,
          toState: InventoryClaimState.FREE,
          actorId: REPAIR_ACTOR,
          reason,
          effectiveFrom: now,
        },
      });
    }
  });

  console.log(`\n✓ committed: ${stuck.length} rooms reset`);
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
