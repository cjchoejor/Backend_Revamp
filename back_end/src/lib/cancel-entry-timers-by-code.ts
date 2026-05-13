import type { PrismaClient } from "@prisma/client";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

/** Best-effort cancel of scheduled timers for an entry (e.g. S8 re-entry per SIG §3.7). */
export async function cancelEntryTimersByCode(
  prisma: PrismaClient,
  args: { entryId: string; timerCodes: string[]; cancelledBy: string; cancelledReason: string },
) {
  if (!args.timerCodes.length) return;
  const timers = await prisma.timerRecord.findMany({
    where: { entryId: args.entryId, timerCode: { in: args.timerCodes }, status: "SCHEDULED" },
  });
  if (!timers.length) return;
  const engine = await getTimerEngine();
  const now = new Date();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: args.cancelledBy, cancelledReason: args.cancelledReason },
  });
}
