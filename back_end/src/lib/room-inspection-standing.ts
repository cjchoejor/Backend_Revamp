import type { Prisma, PrismaClient, RoomInspectionRecord } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Where a booking's room inspection stands (2026-09-18) — read the same way the S9 closure gate
 * reads it (`ensureInspectionResolved`), so the desk, the inspection route and the gate agree.
 *
 * - NOT_RECORDED — no inspection at all (the S9 gate refuses with INSPECTION_MISSING).
 * - DONE         — inspected, at check-out or after departure.
 * - PUT_OFF      — put off at check-out and still open; completable at S9. `windowEndsAt` is the
 *                  W9 timer's due time, and `windowTimerScheduled` says whether the FOM can still
 *                  close the window by hand (the expire route needs that timer).
 * - LAPSED       — put off, and the window closed with nothing recorded (W9 fired, or the FOM).
 */
export type RoomInspectionStanding =
  | { state: "NOT_RECORDED"; inspection: null }
  | { state: "DONE"; inspection: RoomInspectionRecord }
  | { state: "PUT_OFF"; inspection: RoomInspectionRecord; windowEndsAt: Date | null; windowTimerScheduled: boolean }
  | { state: "LAPSED"; inspection: RoomInspectionRecord; lapsedAt: Date };

export async function readRoomInspectionStanding(db: DbClient, entryId: string): Promise<RoomInspectionStanding> {
  const latest = await db.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!latest) return { state: "NOT_RECORDED", inspection: null };
  if (!latest.isDeferred) return { state: "DONE", inspection: latest };

  const completed = await db.roomInspectionRecord.findFirst({
    where: { entryId, isDeferred: false },
    orderBy: { createdAt: "desc" },
  });
  if (completed) return { state: "DONE", inspection: completed };

  const lapse = await db.traceEvent.findFirst({
    where: { entryId, eventType: "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED" },
    orderBy: { timestamp: "desc" },
  });
  if (lapse) return { state: "LAPSED", inspection: latest, lapsedAt: lapse.timestamp };

  const timer = await db.timerRecord.findFirst({
    where: { entryId, timerCode: "POST_CHECKOUT_INSPECTION_W9", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  return { state: "PUT_OFF", inspection: latest, windowEndsAt: timer?.dueAt ?? null, windowTimerScheduled: !!timer };
}
