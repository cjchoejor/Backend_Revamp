import { randomUUID } from "node:crypto";
import { Stage, type Prisma, type PrismaClient } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";
import { getRegistryPolicy } from "./policy-registry-runtime.js";
import { hotelLocalTimeOn } from "./stay-dates.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * When the guest is expected, and so when they become a no-show (2026-09-18).
 *
 * SIG-S5 §7.3: the no-show cut-off fires at "expected arrival time + noShow.cutoffWindowMinutes".
 * Nothing stored an arrival TIME, so the cut-off counted from the stored check-in date — UTC
 * midnight, 06:00 in Bhutan — and a guest due that afternoon read as a no-show at 08:00. The
 * expected arrival is now the guest's own time (Entry.expectedArrivalTime) when the desk has one,
 * else the hotel's standard check-in time (config checkIn.standardTime), on the check-in day in
 * hotel time.
 */

export const DEFAULT_CHECK_IN_TIME = "14:00";
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeOfDay(v: unknown): v is string {
  return typeof v === "string" && TIME_OF_DAY.test(v);
}

/** The hotel's standard check-in time — the configured value, or 14:00 if it is missing or malformed. */
export async function resolveStandardCheckInTime(db: DbClient): Promise<string> {
  try {
    const v = await requireActiveConfigValue<string>(db as PrismaClient, "checkIn.standardTime");
    if (isTimeOfDay(v)) return v;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_CHECK_IN_TIME;
}

/** The grace after the expected arrival before the no-show process starts, in minutes. */
export async function resolveNoShowGraceMinutes(db: DbClient): Promise<number> {
  // The admin-editable registry row wins over the older ConfigurationEntry (disable it to fall back).
  const policy = await getRegistryPolicy(db as PrismaClient, "registry.noShow.graceMinutes");
  if (policy && policy.enabled !== false && typeof policy.graceMinutes === "number") return policy.graceMinutes as number;
  return requireActiveConfigValue<number>(db as PrismaClient, "noShow.cutoffWindowMinutes");
}

export type ExpectedArrival = {
  /** The instant the guest is expected; null when the booking has no check-in date. */
  at: Date | null;
  /** "HH:MM", hotel-local. */
  time: string;
  /** Whose time it is: the guest's own, or the hotel's standard check-in time. */
  source: "GUEST" | "HOTEL";
};

export async function resolveExpectedArrival(
  db: DbClient,
  entry: {
    checkInDate: Date | null;
    expectedArrivalTime?: string | null;
    reservation?: { frozenCheckInDate: Date } | null;
  },
): Promise<ExpectedArrival> {
  const own = isTimeOfDay(entry.expectedArrivalTime) ? entry.expectedArrivalTime : null;
  const time = own ?? (await resolveStandardCheckInTime(db));
  const date = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  return { at: date ? hotelLocalTimeOn(date, time) : null, time, source: own ? "GUEST" : "HOTEL" };
}

/**
 * Arm the no-show cut-off for a booking at `cutoffAt`: any clock still running is stopped (row
 * and job) and one fresh clock is set — exactly one live cut-off per booking. The job carries
 * its TimerRecord id so the worker marks the right record when it fires.
 */
export async function armNoShowCutoff(prisma: PrismaClient, entryId: string, cutoffAt: Date, actorId: string) {
  const engine = await getTimerEngine();
  const running = await prisma.timerRecord.findMany({
    where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (running.length) {
    await prisma.timerRecord.updateMany({
      where: { id: { in: running.map((r) => r.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actorId, cancelledReason: "No-show cut-off re-armed" },
    });
    for (const r of running) if (r.pgBossJobId) await engine.cancel(r.pgBossJobId);
  }
  const timerRecordId = randomUUID();
  const jobId = await engine.schedule("NO_SHOW_CUTOFF_W5", { entryId, timerRecordId }, { startAfter: cutoffAt });
  await prisma.timerRecord.create({
    data: {
      id: timerRecordId,
      entryId,
      entityType: "Entry",
      entityId: entryId,
      timerType: "NO_SHOW_CUTOFF_W5",
      timerCode: "NO_SHOW_CUTOFF_W5",
      stageContext: Stage.S5,
      firesAt: cutoffAt,
      dueAt: cutoffAt,
      status: "SCHEDULED",
      payload: { entryId, timerRecordId, cutoffAt: cutoffAt.toISOString() },
      pgBossJobId: jobId,
      createdBy: actorId,
    },
  });
  return { timerRecordId, cutoffAt };
}
