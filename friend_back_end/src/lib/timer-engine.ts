import { PgBoss } from "pg-boss";
// pg ships no bundled types and @types/pg is not a dependency here — type the tiny surface we use.
// @ts-ignore
import pgPkg from "pg";

type QueryPool = {
  query<T>(text: string, values: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
const Pool = (pgPkg as any).Pool as new (config: { connectionString: string; max?: number }) => QueryPool;

export type TimerJobName =
  | "STAGE_DWELL_MONITOR"
  | "PROCESSING_LOCK_TTL"
  | "ENTRY_EXPIRY"
  | "OTA_EMAIL_PARSER_POLL"
  | "QUOTATION_VALIDITY_W15"
  | "QUOTATION_ACK_TRACKER"
  | "ACKNOWLEDGEMENT_WINDOW_W22"
  | "SPECULATIVE_HOLD_EXPIRY_W2"
  | "COMMITTED_HOLD_EXPIRY_W3"
  | "ADVANCE_PAYMENT_FOLLOW_UP_W34"
  | "PRE_ARRIVAL_COUNTDOWN_W4"
  | "NO_SHOW_CUTOFF_W5"
  | "AWAITING_WRITTEN_CONFIRMATION_W5"
  | "ROOM_READINESS_SLA_W23"
  /// SIG-S6 — async staff ping / observability after VIP commencement record (idempotent).
  | "VIP_ARRIVAL_NOTIFICATION_W14"
  | "H2_H3_ACCEPTANCE_W25"
  | "H4_ACCEPTANCE_W25"
  | "NIGHT_AUDIT_W6"
  /// SIG-S5 Policy 59 — per stay-night registration fired during pre-arrival (informational / trace).
  | "NIGHT_AUDIT_STAY_NIGHT_W37"
  // S8/S9 timers (documented pg-boss-backed workers)
  | "PAYMENT_FOLLOW_UP_W8"
  | "POST_CHECKOUT_INSPECTION_W9"
  | "DEFICIENT_RESOLUTION_DEADLINE_W10"
  | "COMMISSION_RATE_MISSING_W11"
  | "CREDIT_CEILING_MONITORING_W12"
  | "AI_AUDIT_SUPPLEMENT_W18"
  | "PAYMENT_MILESTONE_W21"
  | "HOUSEKEEPING_SLA_W24"
  | "CHECKOUT_TIME_W26"
  | "DISPUTE_SLA_W27"
  | "FEEDBACK_SOLICITATION_W28"
  | "EQUIPMENT_RETURN_W29"
  | "GUEST_DATA_RETENTION_P18"
  | "LOST_FOUND_RETENTION_W30"
  | "FOM_OVERRIDE_FREQUENCY_W32";

export type TimerEngine = {
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
  schedule(jobName: TimerJobName, data: unknown, options: { startAfter: Date }): Promise<string>;
  cancel(jobId: string): Promise<void>;
};

export function createTimerEngine(connectionString: string): TimerEngine {
  const boss = new PgBoss({ connectionString });

  // pg-boss v10+ partitions jobs by queue, so `cancel` REQUIRES the queue name:
  // `cancel(queueName, jobId)`. Callers only hold the opaque job id, so we resolve the queue
  // name from pg-boss's own `job` table (its source of truth) before cancelling. A tiny dedicated
  // pool is used for that lookup — created lazily, closed on stop().
  let lookupPool: QueryPool | null = null;
  function getLookupPool() {
    if (!lookupPool) lookupPool = new Pool({ connectionString, max: 2 });
    return lookupPool;
  }

  async function schedule(jobName: TimerJobName, data: unknown, options: { startAfter: Date }) {
    // pg-boss expects startAfter as ISO string in send options.
    const jobId = await boss.send(jobName, data as any, { startAfter: options.startAfter.toISOString() } as any);
    if (!jobId) throw new Error(`Failed to schedule job ${jobName}`);
    return String(jobId);
  }

  return {
    boss,
    async start() {
      await boss.start();
      // Ensure queues exist even if worker runner isn't started yet.
      for (const q of [
        "STAGE_DWELL_MONITOR",
        "PROCESSING_LOCK_TTL",
        "ENTRY_EXPIRY",
        "OTA_EMAIL_PARSER_POLL",
        "QUOTATION_VALIDITY_W15",
        "QUOTATION_ACK_TRACKER",
        "ACKNOWLEDGEMENT_WINDOW_W22",
        "SPECULATIVE_HOLD_EXPIRY_W2",
        "COMMITTED_HOLD_EXPIRY_W3",
        "ADVANCE_PAYMENT_FOLLOW_UP_W34",
        "PRE_ARRIVAL_COUNTDOWN_W4",
        "NO_SHOW_CUTOFF_W5",
        "AWAITING_WRITTEN_CONFIRMATION_W5",
        "ROOM_READINESS_SLA_W23",
        "VIP_ARRIVAL_NOTIFICATION_W14",
        "H2_H3_ACCEPTANCE_W25",
        "H4_ACCEPTANCE_W25",
        "NIGHT_AUDIT_W6",
        "NIGHT_AUDIT_STAY_NIGHT_W37",
        "PAYMENT_FOLLOW_UP_W8",
        "POST_CHECKOUT_INSPECTION_W9",
        "DEFICIENT_RESOLUTION_DEADLINE_W10",
        "COMMISSION_RATE_MISSING_W11",
        "CREDIT_CEILING_MONITORING_W12",
        "AI_AUDIT_SUPPLEMENT_W18",
        "PAYMENT_MILESTONE_W21",
        "HOUSEKEEPING_SLA_W24",
        "CHECKOUT_TIME_W26",
        "DISPUTE_SLA_W27",
        "FEEDBACK_SOLICITATION_W28",
        "EQUIPMENT_RETURN_W29",
        "GUEST_DATA_RETENTION_P18",
        "LOST_FOUND_RETENTION_W30",
        "FOM_OVERRIDE_FREQUENCY_W32",
      ] as const) {
        await (boss as any).createQueue(q);
      }
    },
    async stop() {
      await boss.stop();
      if (lookupPool) {
        const p = lookupPool;
        lookupPool = null;
        await p.end().catch(() => {});
      }
    },
    schedule,
    async cancel(jobId: string) {
      if (!jobId) return;
      try {
        // Resolve the queue name for this job id (pg-boss v12 needs `cancel(queueName, jobId)`).
        const { rows } = await getLookupPool().query<{ name: string }>(
          `SELECT name FROM pgboss.job WHERE id = $1 LIMIT 1`,
          [jobId],
        );
        const queueName = rows[0]?.name;
        // No row → the job already left the active `job` table (completed / already cancelled /
        // archived). Nothing to cancel; treat as a no-op.
        if (!queueName) return;
        await (boss as any).cancel(queueName, jobId);
      } catch (err) {
        // Surface the failure instead of hiding it — a silently-swallowed cancel is exactly the
        // bug that let PARKED entries keep their live expiry timer. The TimerRecord is still marked
        // cancelled by the caller, and the expiry worker's status guard is the backstop.
        console.warn(
          `[timer-engine] failed to cancel job ${jobId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}

