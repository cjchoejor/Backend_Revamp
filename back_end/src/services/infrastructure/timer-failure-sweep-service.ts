import type { PrismaClient } from "@prisma/client";
import { TIMER_QUEUES, type TimerEngine, type TimerJobName } from "../../lib/timer-engine.js";

/**
 * A timer whose job fails outright is sent once more, and one that fails again is recorded as given
 * up (2026-10-26, operator: "a safety net for a timer whose job fails outright — do it").
 *
 * Before this, a job whose worker threw three times (pg-boss's default: two retries at once) was
 * marked failed and nothing ever looked at it again: a hold that should have lapsed kept its rooms,
 * a no-show cut-off never came, and the only sign was a timer record left SCHEDULED in the past.
 * Jobs now retry five times over about a quarter of an hour (TIMER_RETRY in lib/timer-engine.ts);
 * this sweep, run when the workers start and every hour after, takes what still failed:
 *
 * - **Sent once more** — a fresh job with the same details, due now, and the timer record that
 *   pointed at the failed job pointed at the new one (so cancelling the timer still cancels it).
 *   The new job carries `_resentFrom`, so it is never sent a third time.
 * - **Given up** — a job that failed again after being sent once more, or that carries no details
 *   to send. Recorded for the admin's System health page and, when it belongs to a booking, the
 *   booking's history.
 * - **Left alone** — its timer was cancelled or has fired since (the booking moved on), its booking
 *   no longer exists, or it is the night audit (whose own catch-up runs a missed night).
 *
 * Each failed job is looked at once: the sweep's trace for it (`entityType: "TimerJob"`, its id) is
 * the mark. pg-boss keeps a failed job for 7 days after it failed, so the sweep looks back that far.
 */

export const TIMER_FAILURE_LOOKBACK_DAYS = 7;
const LEFT_ALONE_QUEUES = new Set<string>(["NIGHT_AUDIT_W6"]);
const SWEEP_EVENTS = ["TIMER.JOB_RESENT", "TIMER.JOB_GAVE_UP", "TIMER.JOB_LEFT"] as const;

export type FailedTimerJob = {
  id: string;
  queue: string;
  data: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  dueAt: Date;
  failedAt: Date | null;
};

type JobRow = {
  id: string;
  name: string;
  data: unknown;
  output: unknown;
  retry_count: number;
  start_after: Date;
  completed_on: Date | null;
};

function errorText(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") return output.slice(0, 400);
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message : typeof o.value === "string" ? o.value : JSON.stringify(o);
    return msg.replace(/\s+/g, " ").trim().slice(0, 400);
  }
  return String(output).slice(0, 400);
}

/** The timer jobs that ended failed in the look-back window, oldest first. */
export async function listFailedTimerJobs(prisma: PrismaClient, days = TIMER_FAILURE_LOOKBACK_DAYS): Promise<FailedTimerJob[]> {
  const rows = await prisma.$queryRawUnsafe<JobRow[]>(
    `SELECT id::text AS id, name, data, output, retry_count, start_after, completed_on
       FROM pgboss.job
      WHERE state = 'failed'
        AND name = ANY($1::text[])
        AND COALESCE(completed_on, start_after) > now() - ($2::int * interval '1 day')
      ORDER BY COALESCE(completed_on, start_after) ASC`,
    [...TIMER_QUEUES],
    days,
  );
  return rows.map((r) => ({
    id: r.id,
    queue: r.name,
    data: r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : null,
    error: errorText(r.output),
    attempts: (r.retry_count ?? 0) + 1,
    dueAt: r.start_after,
    failedAt: r.completed_on,
  }));
}

export type SweepOutcome = "RESENT" | "GAVE_UP" | "LEFT";
export type SweepResult = {
  jobId: string;
  queue: string;
  outcome: SweepOutcome | "WOULD_RESEND" | "WOULD_GIVE_UP" | "WOULD_LEAVE";
  reason: string;
  newJobId?: string;
  entryId?: string | null;
};

type Decision = { outcome: SweepOutcome; reason: string; timerRecordId?: string | null; entryId: string | null };

async function decide(prisma: PrismaClient, job: FailedTimerJob): Promise<Decision> {
  const data = job.data ?? {};
  const timer = await prisma.timerRecord.findFirst({ where: { pgBossJobId: job.id }, select: { id: true, status: true, entryId: true } });
  const named = typeof data.entryId === "string" ? data.entryId : (timer?.entryId ?? null);
  const entry = named ? await prisma.entry.findUnique({ where: { id: named }, select: { id: true } }) : null;
  const entryId = entry?.id ?? null;
  if (LEFT_ALONE_QUEUES.has(job.queue)) {
    return { outcome: "LEFT", reason: "The night audit's own catch-up runs a missed night", entryId };
  }
  if (named && !entry) return { outcome: "LEFT", reason: "Its booking no longer exists", entryId: null };
  if (timer && timer.status !== "SCHEDULED") {
    const state = timer.status === "CANCELLED" ? "was cancelled" : "has already fired";
    return { outcome: "LEFT", reason: `Its timer ${state} — nothing waits on it any more`, entryId };
  }
  if (typeof data._resentFrom === "string") {
    return { outcome: "GAVE_UP", reason: "It failed again after being sent once more", timerRecordId: timer?.id ?? null, entryId };
  }
  if (!job.data) return { outcome: "GAVE_UP", reason: "It carries no details to send again", timerRecordId: timer?.id ?? null, entryId };
  return { outcome: "RESENT", reason: "Sent once more", timerRecordId: timer?.id ?? null, entryId };
}

let running = false;

/**
 * Look at every failed timer job not yet swept. `engine` sends the new jobs; `dryRun` writes
 * nothing and says what would happen.
 */
export async function sweepFailedTimerJobs(
  prisma: PrismaClient,
  engine: Pick<TimerEngine, "schedule"> | null,
  opts: { dryRun?: boolean } = {},
): Promise<SweepResult[]> {
  if (running && !opts.dryRun) return [];
  if (!opts.dryRun) running = true;
  try {
    const failed = await listFailedTimerJobs(prisma);
    if (!failed.length) return [];
    const swept = await prisma.traceEvent.findMany({
      where: { entityType: "TimerJob", entityId: { in: failed.map((f) => f.id) }, eventType: { in: [...SWEEP_EVENTS] } },
      select: { entityId: true },
    });
    const done = new Set(swept.map((s) => s.entityId));
    const results: SweepResult[] = [];
    for (const job of failed) {
      if (done.has(job.id)) continue;
      const d = await decide(prisma, job);
      if (opts.dryRun || !engine) {
        const would = d.outcome === "RESENT" ? "WOULD_RESEND" : d.outcome === "GAVE_UP" ? "WOULD_GIVE_UP" : "WOULD_LEAVE";
        results.push({ jobId: job.id, queue: job.queue, outcome: would, reason: d.reason, entryId: d.entryId });
        continue;
      }
      const now = new Date();
      let newJobId: string | undefined;
      let outcome = d.outcome;
      let reason = d.reason;
      if (d.outcome === "RESENT") {
        try {
          newJobId = await engine.schedule(
            job.queue as TimerJobName,
            { ...job.data, _resentFrom: job.id, _resentAt: now.toISOString() },
            { startAfter: now },
          );
          if (d.timerRecordId) {
            await prisma.timerRecord.updateMany({ where: { id: d.timerRecordId, status: "SCHEDULED" }, data: { pgBossJobId: newJobId } });
          }
        } catch (e) {
          outcome = "GAVE_UP";
          reason = `It could not be sent again: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
        }
      }
      await prisma.traceEvent.create({
        data: {
          eventType: outcome === "RESENT" ? "TIMER.JOB_RESENT" : outcome === "GAVE_UP" ? "TIMER.JOB_GAVE_UP" : "TIMER.JOB_LEFT",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "TimerJob",
          entityId: job.id,
          operation: outcome === "RESENT" ? "CREATE" : "ALERT",
          timestamp: now,
          inquiryId: null,
          entryId: d.entryId,
          payload: {
            queue: job.queue,
            reason,
            error: job.error,
            attempts: job.attempts,
            dueAt: job.dueAt.toISOString(),
            failedAt: job.failedAt?.toISOString() ?? null,
            timerRecordId: d.timerRecordId ?? null,
            newJobId: newJobId ?? null,
            resentFrom: typeof job.data?._resentFrom === "string" ? job.data._resentFrom : null,
          },
          createdBy: "SYSTEM",
        },
      });
      results.push({ jobId: job.id, queue: job.queue, outcome, reason, newJobId, entryId: d.entryId });
    }
    return results;
  } finally {
    if (!opts.dryRun) running = false;
  }
}

export type TimerFailureView = FailedTimerJob & {
  entryId: string | null;
  handled: { outcome: SweepOutcome; reason: string; at: Date; newJobId: string | null; newJobState: string | null } | null;
};

/** The admin's view: every failed timer job of the window, with what the sweep did about it. */
export async function describeTimerFailures(prisma: PrismaClient): Promise<{ lookbackDays: number; failures: TimerFailureView[] }> {
  const failed = await listFailedTimerJobs(prisma);
  if (!failed.length) return { lookbackDays: TIMER_FAILURE_LOOKBACK_DAYS, failures: [] };
  const traces = await prisma.traceEvent.findMany({
    where: { entityType: "TimerJob", entityId: { in: failed.map((f) => f.id) }, eventType: { in: [...SWEEP_EVENTS] } },
    select: { entityId: true, eventType: true, timestamp: true, payload: true, entryId: true },
  });
  const byJob = new Map(traces.map((t) => [t.entityId, t]));
  const newIds = traces
    .map((t) => (t.payload as Record<string, unknown> | null)?.newJobId)
    .filter((x): x is string => typeof x === "string");
  const states = newIds.length
    ? await prisma.$queryRawUnsafe<Array<{ id: string; state: string }>>(`SELECT id::text AS id, state::text AS state FROM pgboss.job WHERE id::text = ANY($1::text[])`, newIds)
    : [];
  const stateOf = new Map(states.map((s) => [s.id, s.state]));
  // A booking is named only while it exists — a job naming an erased booking links nowhere.
  const named = [...new Set(failed.map((f) => f.data?.entryId).filter((x): x is string => typeof x === "string"))];
  const existing = named.length
    ? new Set((await prisma.entry.findMany({ where: { id: { in: named } }, select: { id: true } })).map((e) => e.id))
    : new Set<string>();
  const failures = failed
    .map((f) => {
      const t = byJob.get(f.id);
      const p = (t?.payload ?? {}) as Record<string, unknown>;
      const newJobId = typeof p.newJobId === "string" ? p.newJobId : null;
      const own = typeof f.data?.entryId === "string" && existing.has(f.data.entryId) ? f.data.entryId : null;
      return {
        ...f,
        entryId: t?.entryId ?? own,
        handled: t
          ? {
              outcome: (t.eventType === "TIMER.JOB_RESENT" ? "RESENT" : t.eventType === "TIMER.JOB_GAVE_UP" ? "GAVE_UP" : "LEFT") as SweepOutcome,
              reason: typeof p.reason === "string" ? p.reason : "",
              at: t.timestamp,
              newJobId,
              newJobState: newJobId ? (stateOf.get(newJobId) ?? "gone") : null,
            }
          : null,
      };
    })
    .reverse();
  return { lookbackDays: TIMER_FAILURE_LOOKBACK_DAYS, failures };
}
