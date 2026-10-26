import { Prisma, Stage, type PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { addUtcDays, hotelLocalTimeOn, hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
import { planNightForEntries, runNightAudit } from "./s7-night-audit-service.js";

/**
 * The night audit catches up a night its scheduled run missed (2026-10-26, operator: "say the
 * server has been down from 6am to 9am due to power shortage — when it is back up, does the night
 * audit run?"). It did not:
 *
 * - pg-boss starts a scheduled job only when its time passed less than 60 seconds ago
 *   (`shouldSendIt` in pg-boss's timekeeper), so a server off at 08:00 never sends that day's run;
 * - the next morning's run audits only the night just ended, so the missed night was never
 *   audited on its own — its room charges stayed off the in-house guests' bills until the desk
 *   posted them booking by booking, and settlement refused the stay meanwhile.
 *
 * The rule here: a night is caught up when its scheduled run is past by more than the grace (so
 * the scheduled run itself is never raced) and the night has NO audit record at all. A night that
 * has a record — COMPLETE or PARTIAL — was run; a PARTIAL one is the desk's to look at, as before.
 * Nights are run oldest first, through the very same `runNightAudit` the schedule calls:
 * one record per night (the database refuses a second), and every booking line it posts is
 * skipped when already on the folio (a night the desk posted for one booking is not posted twice).
 * It runs when the workers start and every hour after (runner.ts).
 */

/** How far back a missed night is still caught up. */
export const NIGHT_AUDIT_CATCH_UP_DAYS = 7;
/** How long after the scheduled time the catch-up waits, so it never runs beside the schedule. */
export const NIGHT_AUDIT_CATCH_UP_GRACE_MINUTES = 15;

/**
 * When the scheduled run for night N is due. The schedule's run on hotel day D audits night D−1
 * (w6-night-audit-worker), so night N's run is the scheduled time on day N+1:
 * - "HH:MM" (the admin console's form) — that time on the hotel's clock on day N+1;
 * - an older plain daily cron "M H * * *" in UTC — the fire instant that falls on hotel day N+1;
 * - any other cron — the hotel's midnight starting day N+2: a day late, but never early.
 */
export function nightAuditDueAt(night: Date, scheduleValue: string): Date {
  const value = scheduleValue.trim();
  const next = addUtcDays(night, 1);
  const hhmm = /^(\d{2}):(\d{2})$/.exec(value);
  if (hhmm) return hotelLocalTimeOn(next, `${hhmm[1]}:${hhmm[2]}`);
  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(value);
  if (daily) {
    const minute = Number(daily[1]);
    const hour = Number(daily[2]);
    for (const k of [0, 1, 2]) {
      const d = addUtcDays(night, k);
      const fire = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0));
      if (ymdUtc(hotelTodayUtc(fire)) === ymdUtc(next)) return fire;
    }
  }
  return hotelLocalTimeOn(addUtcDays(night, 2), "00:00");
}

export type MissedNight = { night: Date; dueAt: Date };

/** The nights in the look-back window whose scheduled run is past and which have no audit record. */
export async function findMissedNightAudits(prisma: PrismaClient, now: Date = new Date()): Promise<MissedNight[]> {
  const row = await getActiveConfigEntry(prisma, "nightAudit.scheduleTime");
  const schedule = typeof row?.configValue === "string" && row.configValue.trim() ? row.configValue.trim() : "08:00";
  const today = hotelTodayUtc(now);
  const graceMs = NIGHT_AUDIT_CATCH_UP_GRACE_MINUTES * 60_000;
  const candidates: MissedNight[] = [];
  for (let k = NIGHT_AUDIT_CATCH_UP_DAYS; k >= 1; k -= 1) {
    const night = addUtcDays(today, -k);
    const dueAt = nightAuditDueAt(night, schedule);
    if (now.getTime() >= dueAt.getTime() + graceMs) candidates.push({ night, dueAt });
  }
  if (!candidates.length) return [];
  const existing = await prisma.nightAuditRecord.findMany({
    where: { operatingDate: { in: candidates.map((c) => c.night) } },
    select: { operatingDate: true },
  });
  const done = new Set(existing.map((r) => ymdUtc(r.operatingDate)));
  return candidates.filter((c) => !done.has(ymdUtc(c.night)));
}

export type CatchUpResult = {
  night: string;
  dueAt: string;
  outcome: "RAN" | "ALREADY_RUN" | "FAILED" | "WOULD_RUN";
  runStatus?: string;
  recordId?: string;
  error?: string;
  /** Dry run: what the run would post, booking by booking. */
  wouldPost?: Array<{ entryId: string; lines: Array<{ roomNumber: string; description: string; amount: number }> }>;
  notProcessed?: string[];
};

let running = false;

/** Run every missed night, oldest first. `dryRun` writes nothing and says what would be posted. */
export async function catchUpMissedNightAudits(
  prisma: PrismaClient,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<CatchUpResult[]> {
  if (running && !opts.dryRun) return [];
  if (!opts.dryRun) running = true;
  try {
    const now = opts.now ?? new Date();
    const missed = await findMissedNightAudits(prisma, now);
    const results: CatchUpResult[] = [];
    for (const m of missed) {
      const night = ymdUtc(m.night);
      if (opts.dryRun) {
        const { plan, notProcessed } = await planNightForEntries(prisma, m.night);
        results.push({
          night,
          dueAt: m.dueAt.toISOString(),
          outcome: "WOULD_RUN",
          wouldPost: plan
            .filter((p) => p.perRoomPosts.length)
            .map((p) => ({
              entryId: p.entryId,
              lines: p.perRoomPosts.map((x) => ({ roomNumber: x.roomNumber, description: x.description, amount: x.amount })),
            })),
          notProcessed,
        });
        continue;
      }
      try {
        const record = await runNightAudit(prisma, "SYSTEM", { operatingDate: m.night.toISOString() });
        const ranAt = new Date();
        await prisma.traceEvent.create({
          data: {
            eventType: "NIGHT_AUDIT.MISSED_RUN_CAUGHT_UP",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "NightAuditRecord",
            entityId: record.id,
            operation: "RUN",
            timestamp: ranAt,
            stageContext: Stage.S7,
            inquiryId: null,
            entryId: null,
            payload: {
              operatingDate: night,
              dueAt: m.dueAt.toISOString(),
              ranAt: ranAt.toISOString(),
              lateByMinutes: Math.round((ranAt.getTime() - m.dueAt.getTime()) / 60_000),
              runStatus: record.runStatus,
              entriesProcessed: record.entriesProcessedCount,
              entriesNotProcessed: record.entriesNotProcessed,
            },
            createdBy: "SYSTEM",
          },
        });
        results.push({ night, dueAt: m.dueAt.toISOString(), outcome: "RAN", runStatus: record.runStatus, recordId: record.id });
      } catch (e) {
        // Another run took the night between our look and our run (the database keeps one record
        // per night) — the night is done, which is all the catch-up wanted.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          results.push({ night, dueAt: m.dueAt.toISOString(), outcome: "ALREADY_RUN" });
          continue;
        }
        const message = e instanceof Error ? e.message : String(e);
        await prisma.traceEvent
          .create({
            data: {
              eventType: "NIGHT_AUDIT.CATCH_UP_FAILED",
              actorId: "SYSTEM",
              actorLevel: "SYSTEM",
              entityType: "NightAuditRecord",
              entityId: night,
              operation: "RUN",
              timestamp: new Date(),
              stageContext: Stage.S7,
              inquiryId: null,
              entryId: null,
              payload: { operatingDate: night, dueAt: m.dueAt.toISOString(), error: message.slice(0, 500) },
              createdBy: "SYSTEM",
            },
          })
          .catch(() => undefined);
        results.push({ night, dueAt: m.dueAt.toISOString(), outcome: "FAILED", error: message });
      }
    }
    return results;
  } finally {
    if (!opts.dryRun) running = false;
  }
}
