/**
 * Cancel stale prior-segment acknowledgement windows (2026-08-02).
 *
 * Re-entries now cancel ACKNOWLEDGEMENT_WINDOW_W22 timers when they open a new segment
 * (segment-scoped acknowledgement: a sealed segment's reply windows — quote / proforma /
 * voucher / pre-arrival — neither gate nor inform the new segment). Re-entries that ran
 * BEFORE that fix left their windows ticking; this cancels any SCHEDULED W22 timer created
 * before its entry's current segment opened.
 *
 * Dry-run by default. Pass --commit to write.
 * Run from back_end/:  npx tsx scripts/cancel-stale-segment-ack-windows.ts [--commit]
 */
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

async function main() {
  const timers = await prisma.timerRecord.findMany({
    where: { timerCode: "ACKNOWLEDGEMENT_WINDOW_W22", status: "SCHEDULED", entryId: { not: null } },
    select: { id: true, entryId: true, createdAt: true, firesAt: true, stageContext: true },
  });

  const entryIds = Array.from(new Set(timers.map((t) => t.entryId!)));
  const segments = entryIds.length
    ? await prisma.segment.findMany({
        where: { entryId: { in: entryIds } },
        orderBy: [{ entryId: "asc" }, { segmentNumber: "desc" }],
        select: { entryId: true, segmentNumber: true, startedAt: true },
      })
    : [];
  const currentSegStart = new Map<string, Date>();
  for (const s of segments) if (!currentSegStart.has(s.entryId)) currentSegStart.set(s.entryId, s.startedAt);

  const stale = timers.filter((t) => {
    const segStart = currentSegStart.get(t.entryId!);
    return segStart && t.createdAt.getTime() < segStart.getTime();
  });

  console.log(`Scheduled W22 windows: ${timers.length} · stale (pre-current-segment): ${stale.length}`);
  for (const t of stale) {
    console.log(`  ${t.entryId} · window from ${t.createdAt.toISOString()} (stage ${t.stageContext ?? "?"}) fires ${t.firesAt.toISOString()}`);
  }
  if (stale.length === 0 || !COMMIT) {
    if (stale.length > 0) console.log("\nDry run — re-run with --commit to cancel the windows above.");
    return;
  }

  // Row-level cancel: a pg-boss job that still fires no-ops on a CANCELLED TimerRecord.
  const res = await prisma.timerRecord.updateMany({
    where: { id: { in: stale.map((t) => t.id) } },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledBy: ACTOR,
      cancelledReason: "STALE_SEGMENT_ACK_WINDOW_CANCELLED",
    },
  });
  console.log(`\nCancelled ${res.count} stale window${res.count === 1 ? "" : "s"}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
