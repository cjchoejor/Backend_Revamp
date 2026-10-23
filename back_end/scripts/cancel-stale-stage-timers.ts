/**
 * One-off cleanup: cancel SCHEDULED timers that are moot because their entry has already moved
 * past the stage they belong to (or is terminal). These lingered because the cancellation on
 * forward progression was only added recently — pre-existing / imported entries still carry them,
 * where they show as "overdue" in the live feed forever (the workers skip terminal/advanced
 * entries, so this is a cosmetic-hygiene fix, not a correctness one).
 *
 * Scope (SCHEDULED only):
 *   - ENTRY_EXPIRY               → entry no longer at S1
 *   - PRE_ARRIVAL_COUNTDOWN_W4   → entry not at S4 (it fires the move to Arrival), or terminal
 *   - NO_SHOW_CUTOFF_W5          → entry not at S5, or terminal (2026-10-13: before, only
 *                                  "past S5" — a booking sent back kept its clocks)
 *   - STAGE_DWELL_MONITOR        → entry has left the timer's stageContext, or terminal
 *   - NIGHT_AUDIT_STAY_NIGHT_W37 → entry back before Arrival (S1–S4), at Closed, or ended
 *     (2026-10-13: Complaint resolution from Check-in left these ticking at Set up)
 *
 * DRY-RUN by default; pass --commit to write. `--only ENT-…,ENT-…` limits it to those bookings.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const ONLY = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map((x) => x.trim())) : null;
const ACTOR = "actor-cleanup-script";

const OUTSIDE_STAY = new Set(["S1", "S2", "S3", "S4", "S9", "TERMINAL"]);
const TERMINAL_STATUS = new Set(["CLOSED", "CANCELLED", "EXPIRED"]);

function isStale(
  timerType: string,
  timerCode: string | null,
  stageContext: string | null,
  stage: string,
  status: string,
): boolean {
  const terminal = TERMINAL_STATUS.has(status) || stage === "TERMINAL";
  if (timerType === "ENTRY_EXPIRY") {
    // Three clocks share this type: a parked booking's follow-up (good while it is parked, at any
    // step), Negotiation's own window (S2), and the inquiry's (S1). The old rule read every one of
    // them as the inquiry's and would have cancelled live park follow-ups (2026-10-13).
    if (timerCode === "PARKING_FOLLOW_UP") return status !== "PARKED";
    if (timerCode === "NEGOTIATION_EXPIRY") return stage !== "S2" || terminal;
    return stage !== "S1" || terminal;
  }
  if (timerCode === "PRE_ARRIVAL_COUNTDOWN_W4") return stage !== "S4" || terminal;
  if (timerCode === "NO_SHOW_CUTOFF_W5") return stage !== "S5" || terminal;
  if (timerCode === "NIGHT_AUDIT_STAY_NIGHT_W37") return OUTSIDE_STAY.has(stage) || terminal;
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
        { timerCode: { in: ["PRE_ARRIVAL_COUNTDOWN_W4", "NO_SHOW_CUTOFF_W5", "STAGE_DWELL_MONITOR", "NIGHT_AUDIT_STAY_NIGHT_W37"] } },
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
    if (ONLY && !ONLY.has(t.entryId!)) return false;
    return isStale(t.timerType, t.timerCode, t.stageContext ? String(t.stageContext) : null, e.stage, e.status);
  });

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${timers.length} candidate SCHEDULED timer(s); ${stale.length} stale.\n`);
  const byKind: Record<string, number> = {};
  for (const t of stale) {
    const label = t.timerCode || t.timerType;
    byKind[label] = (byKind[label] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byKind)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  for (const t of stale) {
    const e = t.entryId ? stageById.get(t.entryId) : null;
    console.log(`        ${t.entryId} · ${t.timerCode || t.timerType} · booking at ${e?.stage} ${e?.status}`);
  }

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
// The timer engine keeps a pg-boss connection open; without this the script never exits.
process.exit(0);
