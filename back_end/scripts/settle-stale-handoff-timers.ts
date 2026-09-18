/**
 * Settle W25 "handoff to accept" clocks left SCHEDULED after their handoff moved on (2026-09-18).
 *
 *   npx tsx scripts/settle-stale-handoff-timers.ts            # dry run — prints what it would do
 *   npx tsx scripts/settle-stale-handoff-timers.ts --commit   # write
 *
 * Until the W25 worker marked its own record (same day), a W25 clock that fired stayed SCHEDULED
 * forever, and accepting an H4 never stopped its clock — the desk counted both as days overdue.
 * For each W25 clock still SCHEDULED:
 *   - the handoff was ESCALATED (the clock ran out and did its job)          → FIRED at the due time
 *   - the handoff was accepted / fulfilled / rejected / cancelled / closed:
 *       before the due time (the answer beat the clock)                     → CANCELLED
 *       after it (the clock had already run out)                            → FIRED at the due time
 *   - the handoff is gone                                                   → CANCELLED
 *   - the handoff is still waiting (CREATED / ASSIGNED)                     → left alone; reported
 *     when overdue, since that means the job itself was lost
 * Row-level only: no pg-boss job is touched (the worker no longer acts on a clock that is not
 * SCHEDULED). Idempotent — a second run finds nothing to do.
 */
import { prisma } from "../src/db.js";
import { HANDOFF_ACCEPTANCE_TIMER_CODES } from "../src/lib/handoff-acceptance-timers.js";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const now = new Date();
  const clocks = await prisma.timerRecord.findMany({
    where: { status: "SCHEDULED", timerCode: { in: HANDOFF_ACCEPTANCE_TIMER_CODES } },
    orderBy: { dueAt: "asc" },
  });
  const handoffs = await prisma.handoffRecord.findMany({
    where: { id: { in: clocks.map((c) => c.entityId) } },
  });
  const byId = new Map(handoffs.map((h) => [h.id, h]));

  const plan: Array<{ id: string; entryId: string | null; to: "FIRED" | "CANCELLED"; at: Date; why: string; line: string }> = [];
  const stuck: string[] = [];
  for (const c of clocks) {
    const h = byId.get(c.entityId);
    const line = `${c.entryId ?? "-"} · ${c.timerCode} · handoff ${c.entityId}${h ? ` ${h.handoffType} ${h.state}` : " (missing)"} · due ${c.dueAt.toISOString()}`;
    if (!h) {
      plan.push({ id: c.id, entryId: c.entryId, to: "CANCELLED", at: now, why: "Handoff no longer exists", line });
      continue;
    }
    if (h.state === "ESCALATED") {
      plan.push({ id: c.id, entryId: c.entryId, to: "FIRED", at: h.escalatedAt ?? c.dueAt, why: "Window ran out; handoff escalated", line });
      continue;
    }
    const answeredAt = h.acceptedAt ?? h.fulfilledAt ?? h.rejectedAt ?? h.cancelledAt ?? h.closedAt;
    if (["ACCEPTED", "FULFILLED", "REJECTED", "CANCELLED", "CLOSED"].includes(h.state)) {
      if (answeredAt && answeredAt < c.dueAt) {
        plan.push({ id: c.id, entryId: c.entryId, to: "CANCELLED", at: answeredAt, why: `Handoff ${h.state.toLowerCase()} before the window ran out`, line });
      } else {
        plan.push({ id: c.id, entryId: c.entryId, to: "FIRED", at: c.dueAt, why: `Window ran out; handoff since ${h.state.toLowerCase()}`, line });
      }
      continue;
    }
    if (c.dueAt < now) stuck.push(line);
  }

  console.log(`${clocks.length} W25 clock(s) still SCHEDULED · ${plan.length} to settle · ${stuck.length} still waiting past due`);
  for (const p of plan) console.log(`  → ${p.to.padEnd(9)} ${p.line}\n               ${p.why}`);
  for (const s of stuck) console.log(`  ! waiting  ${s}\n               the handoff is still open but its clock never ran — the job was lost; look at it by hand`);

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit.");
    return;
  }
  let written = 0;
  for (const p of plan) {
    const r = await prisma.timerRecord.updateMany({
      where: { id: p.id, status: "SCHEDULED" },
      data:
        p.to === "FIRED"
          ? { status: "FIRED", firedAt: p.at }
          : { status: "CANCELLED", cancelledAt: p.at, cancelledBy: "system", cancelledReason: `${p.why} (settled 2026-09-18)` },
    });
    written += r.count;
  }
  console.log(`\nSettled ${written} clock(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
