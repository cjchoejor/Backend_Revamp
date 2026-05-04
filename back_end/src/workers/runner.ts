import { prisma } from "../db.js";
import { createTimerEngine } from "../lib/timer-engine.js";
import { runStageDwellMonitor } from "./w1-stage-dwell-monitor.js";
import { runProcessingLockExpiryWorker } from "./w16-processing-lock-expiry-worker.js";
import { runEntryExpiryWorker } from "./w20-entry-expiry-worker.js";
import { runOtaEmailParserPollWorker } from "./w7-ota-email-parser-worker.js";
import { runQuotationExpiryWorker } from "./w15-quotation-expiry-worker.js";
import { runQuotationAckTrackerWorker } from "./w22-quotation-ack-tracker-worker.js";
import { runAcknowledgementWindowWorker } from "./w22-acknowledgement-window-worker.js";
import { runSpeculativeHoldExpiryWorker } from "./w2-speculative-hold-expiry-worker.js";
import { runCommittedHoldExpiryWorker } from "./w3-committed-hold-expiry-worker.js";
import { runAdvancePaymentFollowUpWorker } from "./w34-advance-payment-follow-up-worker.js";
import { runPreArrivalWindowActivationWorker } from "./w4-pre-arrival-window-activation-worker.js";
import { runNoShowCutoffWorker } from "./w5-no-show-cutoff-worker.js";
import { runRoomReadinessSlaWorker } from "./w23-room-readiness-sla-worker.js";
import { runHandoffAcceptanceWorker } from "./w25-handoff-acceptance-worker.js";
import { runNightAuditWorker } from "./w6-night-audit-worker.js";
import { runPaymentFollowUpWorker } from "./w8-payment-follow-up-worker.js";
import { runPostCheckoutInspectionWorker } from "./w9-post-checkout-inspection-worker.js";
import { runDeficientResolutionDeadlineWorker } from "./w10-deficient-resolution-deadline-worker.js";
import { runCommissionRateMissingWorker } from "./w11-commission-rate-missing-worker.js";
import { runCreditCeilingMonitoringWorker } from "./w12-credit-ceiling-monitoring-worker.js";
import { runAiAuditSupplementWorker } from "./w18-ai-audit-supplement-worker.js";
import { runPaymentMilestoneWorker } from "./w21-payment-milestone-worker.js";
import { runHousekeepingSlaWorker } from "./w24-housekeeping-sla-worker.js";
import { runCheckoutTimeWorker } from "./w26-checkout-time-worker.js";
import { runDisputeSlaWorker } from "./w27-dispute-sla-worker.js";
import { runFeedbackSolicitationWorker } from "./w28-feedback-solicitation-worker.js";
import { runEquipmentReturnWorker } from "./w29-equipment-return-worker.js";
import { runGuestDataRetentionWorker } from "./w30-guest-data-retention-worker.js";
import { runFomOverrideFrequencyWorkerW32 } from "./w32-fom-override-frequency-worker.js";

export async function startWorkers() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to start workers");

  const engine = createTimerEngine(connectionString);
  await engine.start();
  (engine.boss as any).on?.("error", (e: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss error]", e);
  });

  function unwrapJobData(jobOrBatch: any) {
    const job = Array.isArray(jobOrBatch) ? jobOrBatch[0] : jobOrBatch;
    return (job?.data ?? jobOrBatch?.data ?? {}) as any;
  }

  // Register handlers
  await (engine.boss as any).work("STAGE_DWELL_MONITOR", async (job: any) => runStageDwellMonitor(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("PROCESSING_LOCK_TTL", async (job: any) => runProcessingLockExpiryWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("ENTRY_EXPIRY", async (job: any) => runEntryExpiryWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("OTA_EMAIL_PARSER_POLL", async (job: any) => runOtaEmailParserPollWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("QUOTATION_VALIDITY_W15", async (job: any) => runQuotationExpiryWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("QUOTATION_ACK_TRACKER", async (job: any) => runQuotationAckTrackerWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("ACKNOWLEDGEMENT_WINDOW_W22", async (job: any) => runAcknowledgementWindowWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("SPECULATIVE_HOLD_EXPIRY_W2", async (job: any) => runSpeculativeHoldExpiryWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("COMMITTED_HOLD_EXPIRY_W3", async (job: any) => runCommittedHoldExpiryWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("ADVANCE_PAYMENT_FOLLOW_UP_W34", async (job: any) => runAdvancePaymentFollowUpWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("PRE_ARRIVAL_COUNTDOWN_W4", async (job: any) => runPreArrivalWindowActivationWorker(prisma, engine, unwrapJobData(job)));
  await (engine.boss as any).work(
    "NO_SHOW_CUTOFF_W5",
    async (job: any) => runNoShowCutoffWorker(prisma, engine, { ...(unwrapJobData(job) as any), timerType: "NO_SHOW_CUTOFF_W5" }),
  );
  await (engine.boss as any).work(
    "AWAITING_WRITTEN_CONFIRMATION_W5",
    async (job: any) =>
      runNoShowCutoffWorker(prisma, engine, { ...(unwrapJobData(job) as any), timerType: "AWAITING_WRITTEN_CONFIRMATION_W5" }),
  );
  await (engine.boss as any).work("ROOM_READINESS_SLA_W23", async (job: any) => runRoomReadinessSlaWorker(prisma, engine, unwrapJobData(job)));
  await (engine.boss as any).work("H2_H3_ACCEPTANCE_W25", async (job: any) => runHandoffAcceptanceWorker(prisma, engine, unwrapJobData(job)));
  await (engine.boss as any).work("H4_ACCEPTANCE_W25", async (job: any) => runHandoffAcceptanceWorker(prisma, engine, unwrapJobData(job)));
  await (engine.boss as any).work("NIGHT_AUDIT_W6", async (job: any) => runNightAuditWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("PAYMENT_FOLLOW_UP_W8", async (job: any) => runPaymentFollowUpWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("POST_CHECKOUT_INSPECTION_W9", async (job: any) => runPostCheckoutInspectionWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("DEFICIENT_RESOLUTION_DEADLINE_W10", async (job: any) => runDeficientResolutionDeadlineWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("COMMISSION_RATE_MISSING_W11", async (job: any) => runCommissionRateMissingWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("CREDIT_CEILING_MONITORING_W12", async (job: any) => runCreditCeilingMonitoringWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("AI_AUDIT_SUPPLEMENT_W18", async (job: any) => runAiAuditSupplementWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("PAYMENT_MILESTONE_W21", async (job: any) => runPaymentMilestoneWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("HOUSEKEEPING_SLA_W24", async (job: any) => runHousekeepingSlaWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("CHECKOUT_TIME_W26", async (job: any) => runCheckoutTimeWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("DISPUTE_SLA_W27", async (job: any) => runDisputeSlaWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("FEEDBACK_SOLICITATION_W28", async (job: any) => runFeedbackSolicitationWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("EQUIPMENT_RETURN_W29", async (job: any) => runEquipmentReturnWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("GUEST_DATA_RETENTION_P18", async (job: any) => runGuestDataRetentionWorker(prisma, unwrapJobData(job)));
  await (engine.boss as any).work("FOM_OVERRIDE_FREQUENCY_W32", async (job: any) => runFomOverrideFrequencyWorkerW32(prisma, unwrapJobData(job)));

  return engine;
}

