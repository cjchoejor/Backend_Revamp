import { PgBoss } from "pg-boss";

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
  | "H2_H3_ACCEPTANCE_W25"
  | "H4_ACCEPTANCE_W25"
  | "NIGHT_AUDIT_W6"
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
        "H2_H3_ACCEPTANCE_W25",
        "H4_ACCEPTANCE_W25",
        "NIGHT_AUDIT_W6",
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
        "FOM_OVERRIDE_FREQUENCY_W32",
      ] as const) {
        await (boss as any).createQueue(q);
      }
    },
    async stop() {
      await boss.stop();
    },
    schedule,
    async cancel(jobId: string) {
      if (!jobId) return;
      try {
        // pg-boss cancel signature differs by version; in this codebase cancellation is best-effort.
        await (boss as any).cancel(jobId);
      } catch {
        // Ignore cancellation errors; the TimerRecord remains the source of truth for status.
      }
    },
  };
}

