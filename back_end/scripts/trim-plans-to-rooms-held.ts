/**
 * Put a booking's plan back in line with the rooms it holds (2026-11-28, TEST-ED-LE4-ENT).
 *
 * Before 2026-11-28, taking a room off a stay — or one room leaving early, the rest staying — ended
 * the room's assignment row but left the room on the booking's plan (the newest sealed pick, and the
 * committed hold's night-by-night snapshot) for its later nights. The next extension or room change
 * copied it back with its guests. Since that day the plan follows the room out
 * (lib/plan-room-left.ts); this puts right the bookings left behind before it.
 *
 * For every booking in house (Stay or Check-out, live): each night of the plan keeps only the rooms
 * one of the booking's rows holds that night (a row with no dates holds the whole stay). A night the
 * rows would leave empty is left as it is. Nothing else moves: no row, no price, no bill.
 *
 *   npx tsx scripts/trim-plans-to-rooms-held.ts            # dry run — lists what would change
 *   npx tsx scripts/trim-plans-to-rooms-held.ts --commit   # writes it, traced ENTRY.PLAN_TRIMMED_TO_ROOMS_HELD
 *   --only ENT-…                                           # one booking
 *
 * Audit check A21_PLAN_NOT_ROOMS_HELD (scripts/audit-money.ts) finds the same bookings.
 */
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

type NightRow = { date: string; roomIds: unknown[] } & Record<string, unknown>;
const roomIdOf = (r: unknown): string | null =>
  typeof r === "string" ? r : typeof (r as { roomId?: unknown } | null)?.roomId === "string" ? (r as { roomId: string }).roomId : null;

async function main() {
  const entries = await prisma.entry.findMany({
    where: { status: "ACTIVE", currentStage: { in: ["S7", "S8"] }, ...(ONLY ? { id: ONLY } : {}) },
    select: {
      id: true,
      inquiryId: true,
      currentStage: true,
      roomAssignments: { select: { roomId: true, startDate: true, endDate: true, room: { select: { roomNumber: true } } } },
      committedHold: { select: { id: true, perNightBreakdown: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
        select: { id: true, optionSelected: true },
      },
    },
  });
  let changedCount = 0;
  for (const e of entries) {
    if (!e.roomAssignments.length) continue;
    const holds = (roomId: string, night: string) => {
      const t = Date.parse(`${night}T00:00:00.000Z`);
      return e.roomAssignments.some(
        (a) => a.roomId === roomId && (a.startDate == null || a.endDate == null || (a.startDate.getTime() <= t && t < a.endDate.getTime())),
      );
    };
    const numberOf = (roomId: string) => e.roomAssignments.find((a) => a.roomId === roomId)?.room.roomNumber ?? roomId.slice(0, 6);
    const trim = (rows: NightRow[]) => {
      const dropped: string[] = [];
      const out = rows.map((n) => {
        const night = String(n.date).slice(0, 10);
        const kept = n.roomIds.filter((r) => {
          const id = roomIdOf(r);
          return !id || holds(id, night);
        });
        if (!kept.length) return n; // never leave a night with no room
        for (const r of n.roomIds) if (!kept.includes(r)) dropped.push(`Room ${numberOf(roomIdOf(r)!)} on ${night}`);
        return { ...n, roomIds: kept };
      });
      return { out, dropped };
    };

    const seal = e.availabilityConfigs[0];
    const opt = seal?.optionSelected as Record<string, unknown> | null | undefined;
    const pick = Array.isArray(opt?.perNight) ? trim(opt!.perNight as NightRow[]) : null;
    const holdRows = Array.isArray(e.committedHold?.perNightBreakdown) ? trim(e.committedHold!.perNightBreakdown as unknown as NightRow[]) : null;
    if (!pick?.dropped.length && !holdRows?.dropped.length) continue;
    changedCount++;
    console.log(`${e.id} (${e.currentStage})`);
    if (pick?.dropped.length) console.log(`  the pick drops ${pick.dropped.join(", ")}`);
    if (holdRows?.dropped.length) console.log(`  the hold drops ${holdRows.dropped.join(", ")}`);
    if (!COMMIT) continue;
    await prisma.$transaction(async (tx) => {
      if (seal && pick?.dropped.length) {
        await tx.availabilityConfiguration.update({ where: { id: seal.id }, data: { optionSelected: { ...opt!, perNight: pick.out } as Prisma.InputJsonValue } });
      }
      if (e.committedHold && holdRows?.dropped.length) {
        await tx.committedHold.update({ where: { id: e.committedHold.id }, data: { perNightBreakdown: holdRows.out as unknown as Prisma.InputJsonValue } });
      }
      await tx.traceEvent.create({
        data: {
          eventType: "ENTRY.PLAN_TRIMMED_TO_ROOMS_HELD",
          actorId: "SYSTEM",
          actorLevel: "L4",
          entityType: "Entry",
          entityId: e.id,
          operation: "UPDATE",
          timestamp: new Date(),
          stageContext: e.currentStage,
          inquiryId: e.inquiryId,
          entryId: e.id,
          payload: {
            script: "trim-plans-to-rooms-held",
            pickDropped: pick?.dropped ?? [],
            holdDropped: holdRows?.dropped ?? [],
            why: "A room had left the stay but was still on the booking's plan for its later nights",
          },
          createdBy: "SYSTEM",
        },
      });
    });
    console.log("  written");
  }
  console.log(`\n${changedCount} booking(s) ${COMMIT ? "put right" : "would change"}${COMMIT ? "" : " — run with --commit to write"}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
