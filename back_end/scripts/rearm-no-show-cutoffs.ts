/**
 * Re-arm no-show cut-offs set from midnight (2026-09-18).
 *
 *   npx tsx scripts/rearm-no-show-cutoffs.ts            # dry run — prints what it would do
 *   npx tsx scripts/rearm-no-show-cutoffs.ts --commit   # write (starts the timer engine)
 *
 * Until today the cut-off counted from the stored check-in date — UTC midnight, 06:00 in Bhutan —
 * so it fell hours before the guest could arrive. For every booking at Arrival (S5) with no
 * no-show decision, the correct cut-off is the expected arrival (the guest's time, else the
 * hotel's check-in time) plus the grace:
 *   - cut-off not reached, clock due at the wrong time  → re-armed at the correct time
 *   - reached EARLY and the correct time is still ahead → the mark is cleared and the clock re-armed
 *     (the early firing was the bug, not a no-show)
 *   - reached, and the correct time has passed too      → the mark stands; a clock row still
 *     SCHEDULED is marked FIRED (it fired — the old job carried no record id)
 * Re-running finds nothing to do.
 */
import { prisma } from "../src/db.js";
import { armNoShowCutoff, resolveExpectedArrival, resolveNoShowGraceMinutes } from "../src/lib/expected-arrival.js";

const COMMIT = process.argv.includes("--commit");
const SLACK_MS = 60_000;

async function main() {
  const now = new Date();
  const grace = await resolveNoShowGraceMinutes(prisma);
  const entries = await prisma.entry.findMany({
    where: { currentStage: "S5", status: { in: ["ACTIVE", "PARKED"] }, noShowDetermination: null },
    include: { reservation: { select: { frozenCheckInDate: true } } },
  });
  let acted = 0;
  for (const e of entries) {
    const expected = await resolveExpectedArrival(prisma, e);
    if (!expected.at) continue;
    const correct = new Date(expected.at.getTime() + grace * 60_000);
    const clocks = await prisma.timerRecord.findMany({
      where: { entryId: e.id, timerCode: "NO_SHOW_CUTOFF_W5", status: "SCHEDULED" },
      select: { id: true, dueAt: true },
    });
    const reached = e.noShowCutoffReachedAt;
    const line = `${e.id} · expected ${expected.time} (${expected.source.toLowerCase()}) · correct cut-off ${correct.toISOString()}`;
    let plan: string | null = null;
    let run: (() => Promise<void>) | null = null;
    if (!reached) {
      const right = clocks.length === 1 && Math.abs(clocks[0].dueAt.getTime() - correct.getTime()) < SLACK_MS;
      if (!right) {
        plan = `re-arm (clock ${clocks.map((c) => c.dueAt.toISOString()).join(", ") || "none"})`;
        run = async () => void (await armNoShowCutoff(prisma, e.id, correct, "SYSTEM"));
      }
    } else if (reached.getTime() + SLACK_MS < correct.getTime() && correct > now) {
      plan = `reached early at ${reached.toISOString()} — clear the mark and re-arm`;
      run = async () => {
        await prisma.entry.update({ where: { id: e.id }, data: { noShowCutoffReachedAt: null, version: { increment: 1 } } });
        await armNoShowCutoff(prisma, e.id, correct, "SYSTEM");
        await prisma.traceEvent.create({
          data: {
            eventType: "NO_SHOW_CUTOFF.REARMED",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "Entry",
            entityId: e.id,
            operation: "UPDATE",
            timestamp: new Date(),
            stageContext: "S5",
            inquiryId: e.inquiryId,
            entryId: e.id,
            payload: { reachedAt: reached.toISOString(), cutoffAt: correct.toISOString(), reason: "cut-off had counted from midnight" },
            createdBy: "SYSTEM",
          },
        });
      };
    } else if (clocks.length) {
      plan = `reached (the correct time has passed too) — mark ${clocks.length} leftover clock row(s) FIRED`;
      run = async () =>
        void (await prisma.timerRecord.updateMany({
          where: { id: { in: clocks.map((c) => c.id) }, status: "SCHEDULED" },
          data: { status: "FIRED", firedAt: reached },
        }));
    }
    if (!plan) continue;
    acted++;
    console.log(`  ${line}\n    → ${plan}`);
    if (COMMIT && run) await run();
  }
  console.log(`${entries.length} booking(s) at Arrival · ${acted} to fix${COMMIT ? " · done" : " · dry run, nothing written (re-run with --commit)"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
