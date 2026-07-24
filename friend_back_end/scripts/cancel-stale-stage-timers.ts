/**
 * One-off cleanup: cancel SCHEDULED timers that are moot because their entry has already moved
 * past the stage they belong to (or is terminal). These lingered because the cancellation on
 * forward progression was only added recently — pre-existing / imported entries still carry them,
 * where they show as "overdue" in the live feed forever (the workers skip terminal/advanced
 * entries, so this is a cosmetic-hygiene fix, not a correctness one).
 *
 * Scope (SCHEDULED only):
 *   - ENTRY_EXPIRY               → entry no longer at S1
 *   - PRE_ARRIVAL_COUNTDOWN_W4   → entry past S5 (S6+) or terminal
 *   - NO_SHOW_CUTOFF_W5          → entry past S5 (S6+) or terminal
 *   - STAGE_DWELL_MONITOR        → entry has left the timer's stageContext, or terminal
 *
 * DRY-RUN by default; pass --commit to write.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-cleanup-script";

const PAST_S5 = new Set(["S6", "S7", "S8", "S9", "TERMINAL"]);
const TERMINAL_STATUS = new Set(["CLOSED", "CANCELLED", "EXPIRED"]);

function isStale(
  timerType: string,
  timerCode: string | null,
  stageContext: string | null,
  stage: string,
  status: string,
): boolean {
  const terminal = TERMINAL_STATUS.has(status) || stage === "TERMINAL";
  if (timerType === "ENTRY_EXPIRY") return stage !== "S1"; // moot once past Inquiry
  if (timerCode === "PRE_ARRIVAL_COUNTDOWN_W4" || timerCode === "NO_SHOW_CUTOFF_W5") {
    return PAST_S5.has(stage) || terminal;
  }
  // STAGE_DWELL_MONITOR belongs to exactly one stage (its stageContext). It's moot once the entry
  // has left that stage (current stage differs) or has reached a terminal state. Exactly one dwell
  // monitor should be live at a time — the current stage's.
  if (timerCode === "STAGE_DWELL_MONITOR") {
    if (terminal) return true;
    return !!stageContext && stageContext !== stage;
  }
  return false;
}

async function main() {
  const timers = await prisma.timerRecord.findMany({
    where: {
      status: "SCHEDULED",
      OR: [
        { timerType: "ENTRY_EXPIRY" },
        { timerCode: { in: ["PRE_ARRIVAL_COUNTDOWN_W4", "NO_SHOW_CUTOFF_W5", "STAGE_DWELL_MONITOR"] } },
      ],
    },
    select: { id: true, timerType: true, timerCode: true, stageContext: true, entryId: true, pgBossJobId: true },
  });

  const entryIds = [...new Set(timers.map((t) => t.entryId).filter(Boolean))] as string[];
  const entries = await prisma.entry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, currentStage: true, status: true },
  });
  const stageById = new Map(entries.map((e) => [e.id, { stage: String(e.currentStage), status: String(e.status) }]));

  const stale = timers.filter((t) => {
    const e = t.entryId ? stageById.get(t.entryId) : null;
    if (!e) return false;
    return isStale(t.timerType, t.timerCode, t.stageContext ? String(t.stageContext) : null, e.stage, e.status);
  });

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${timers.length} candidate SCHEDULED timer(s); ${stale.length} stale.\n`);
  const byKind: Record<string, number> = {};
  for (const t of stale) {
    const label = t.timerCode || t.timerType;
    byKind[label] = (byKind[label] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byKind)) console.log(`  ${String(n).padStart(4)}  ${k}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to cancel these.`);
    return;
  }
  if (stale.length === 0) {
    console.log(`\nNothing to cancel.`);
    return;
  }

  const now = new Date();
  const { getTimerEngine } = await import("../src/services/infrastructure/timer-management-service.js");
  const engine = await getTimerEngine();
  await Promise.all(stale.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId).catch(() => {}) : Promise.resolve())));
  const res = await prisma.timerRecord.updateMany({
    where: { id: { in: stale.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: ACTOR, cancelledReason: "STALE_STAGE_TIMER_CLEANUP" },
  });
  console.log(`\nCancelled ${res.count} stale timer(s).`);
}

await main();
await prisma.$disconnect();
