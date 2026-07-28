import type { Prisma, PrismaClient } from "@prisma/client";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Cancel any previous `STAGE_DWELL_MONITOR` timers still SCHEDULED for this entry
 * (fixed 2026-07-28 — desk was showing S2's overdue chip alongside S3's fresh one).
 *
 * Each `scheduleSNStageDwellWarningMonitor` calls this before creating its own timer, so
 * only ONE dwell monitor is ever alive per entry. Without this, moving S2→S3 leaves the
 * S2 chip running (goes overdue), then S3 stacks on top, then S4 stacks again — the timer
 * panel accumulates ghost rows until each fires and its worker skips (they're functionally
 * harmless but visually confusing, exactly like the ACK_WINDOW_W22 ghost we fixed at accept).
 *
 * Cancels BOTH sides:
 *   - `pgBossJobId` (prevents the worker from ever running)
 *   - `TimerRecord.status` → CANCELLED (removes the row from the desk's timer feed)
 */
export async function cancelActiveStageDwellMonitors(
  db: Db,
  entryId: string,
  actorId: string,
): Promise<void> {
  const now = new Date();
  const timers = await db.timerRecord.findMany({
    where: {
      entryId,
      timerType: "STAGE_DWELL_MONITOR",
      status: "SCHEDULED",
    },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length === 0) return;

  const engine = await getTimerEngine();
  await Promise.all(
    timers
      .map((t) => t.pgBossJobId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => engine.cancel(id)),
  );

  await db.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledBy: actorId,
      cancelledReason: "STAGE_PROGRESSED",
    },
  });
}
