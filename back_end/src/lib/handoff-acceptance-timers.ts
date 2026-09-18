import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * The W25 "handoff to accept" clocks (2026-09-18). One per handoff; the code names which kind.
 * A W25 clock waits for ONE thing — the receiving department accepting the handoff — so once the
 * handoff is accepted, fulfilled, rejected or cancelled the clock has nothing left to watch.
 */
export const HANDOFF_ACCEPTANCE_TIMER_CODES = ["H2_H3_ACCEPTANCE_W25", "H4_ACCEPTANCE_W25", "HANDOFF_ACCEPTANCE_W25"];

/**
 * Stop a handoff's acceptance clocks at the row: SCHEDULED → CANCELLED. Row-level on purpose, so
 * it runs inside the caller's transaction; the pg-boss job, if it still fires, finds no SCHEDULED
 * row and no longer acts (the W25 worker skips a cancelled clock). Returns the rows it stopped,
 * with their job ids, for a caller that wants to cancel the jobs too.
 */
export async function cancelHandoffAcceptanceTimers(
  db: DbClient,
  handoffIds: string[],
  args: { actorId: string; reason: string },
): Promise<Array<{ id: string; pgBossJobId: string | null }>> {
  if (handoffIds.length === 0) return [];
  const rows = await db.timerRecord.findMany({
    where: {
      entityType: "HandoffRecord",
      entityId: { in: handoffIds },
      timerCode: { in: HANDOFF_ACCEPTANCE_TIMER_CODES },
      status: "SCHEDULED",
    },
    select: { id: true, pgBossJobId: true },
  });
  if (rows.length === 0) return rows;
  await db.timerRecord.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: args.actorId, cancelledReason: args.reason },
  });
  return rows;
}
