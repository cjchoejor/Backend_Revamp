/**
 * Release stale cross-segment committed holds (2026-08-02).
 *
 * A hold is STALE when it is still live (PLACED / CONFIRMED) but belongs to a segment that is
 * no longer the entry's current segment. Re-entries now release the hold when they open a new
 * segment (S3→S1/S3→S2 directly; S4→S1/S5→S1 via the backflow hooks — including CONFIRMED
 * holds since 2026-08-02), but re-entries that ran BEFORE those fixes left their hold behind:
 * the sealed segment's rooms stay pinned and the desk shows the booking as still holding them.
 *
 * NOT touched: holds whose segmentId IS the current segment (live commitments), and entries
 * past the freeze whose CURRENT reservation legitimately rides on the confirmed hold — only
 * pre-S4 stages (S1/S2/S3) qualify, where a new segment always re-places its own hold.
 *
 * Dry-run by default — prints what would be released. Pass --commit to write.
 * Run from back_end/:  npx tsx scripts/release-stale-segment-holds.ts [--commit]
 */
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

function heldRoomIds(hold: { roomId: string | null; perNightBreakdown: unknown }): string[] {
  const ids = new Set<string>();
  if (hold.roomId) ids.add(hold.roomId);
  const nights = hold.perNightBreakdown as Array<{ roomIds?: Array<{ roomId?: string }> }> | null;
  if (Array.isArray(nights)) {
    for (const n of nights) for (const r of n.roomIds ?? []) if (r?.roomId) ids.add(r.roomId);
  }
  return [...ids];
}

async function main() {
  const holds = await prisma.committedHold.findMany({
    where: { state: { in: ["PLACED", "CONFIRMED"] } },
    include: { entry: { include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } } },
  });

  const stale = holds.filter((h) => {
    const cur = h.entry?.segments?.[0];
    // Pre-freeze stages only — a confirmed booking's current hold backs its reservation.
    const preFreeze = h.entry && ["S1", "S2", "S3"].includes(h.entry.currentStage);
    return cur && h.segmentId !== cur.id && preFreeze;
  });

  console.log(`Live holds: ${holds.length} · stale prior-segment holds (entry at S1–S3): ${stale.length}`);
  if (stale.length === 0) return;

  for (const h of stale) {
    const cur = h.entry.segments[0];
    const roomIds = heldRoomIds(h);
    const rooms = roomIds.length
      ? await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, roomNumber: true, currentClaimState: true } })
      : [];
    console.log(
      `\n${h.entryId} · stage ${h.entry.currentStage} · hold ${h.state} on sealed segment (current is #${cur.segmentNumber})`,
    );
    for (const r of rooms) console.log(`   room ${r.roomNumber} claimState=${r.currentClaimState}`);

    if (!COMMIT) continue;

    await prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const r of rooms) {
        if (r.currentClaimState === "FREE") continue;
        await tx.room.update({ where: { id: r.id }, data: { currentClaimState: "FREE" } });
        await tx.roomClaimStateEvent.create({
          data: {
            roomId: r.id,
            entryId: h.entryId,
            fromState: r.currentClaimState,
            toState: "FREE",
            actorId: ACTOR,
            reason: "STALE_SEGMENT_HOLD_RELEASED",
            effectiveFrom: now,
          },
        });
      }
      // Cancel the hold's scheduled expiry timers. The pg-boss jobs may still fire, but W3
      // re-checks hold state and no-ops on a RELEASED hold — same tolerance the workers rely on.
      await tx.timerRecord.updateMany({
        where: { entityType: "CommittedHold", entityId: h.id, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: ACTOR, cancelledReason: "STALE_SEGMENT_HOLD_RELEASED" },
      });
      await tx.committedHold.update({
        where: { id: h.id },
        data: { state: "RELEASED", releasedAt: now, releasedBy: ACTOR, releaseReason: "STALE_SEGMENT_HOLD_RELEASED" },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "HOLD.RELEASED_ON_REENTRY",
          actorId: ACTOR,
          actorLevel: "L4",
          entityType: "CommittedHold",
          entityId: h.id,
          operation: "RELEASE",
          timestamp: now,
          stageContext: "S3",
          entryId: h.entryId,
          payload: { entryId: h.entryId, committedHoldId: h.id, releaseReason: "STALE_SEGMENT_HOLD_RELEASED", repairScript: true },
          createdBy: ACTOR,
        },
      });
    });
    console.log("   → RELEASED");
  }

  if (!COMMIT) console.log("\nDry run — re-run with --commit to release the holds above.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
