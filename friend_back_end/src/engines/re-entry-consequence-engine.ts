import type { PrismaClient, Prisma } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * AC-S7-22: consequences must be computed before commit and executed in same tx.
 * In this repo slice, we model consequences as a TraceEvent marker.
 */
export async function computeReEntryConsequences(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { entryId: string; fromStage: Stage; toStage: Stage; reason: string; actorId: string },
) {
  const now = new Date();
  const consequences: string[] = [];

  if (input.fromStage === Stage.S3 && input.toStage === Stage.S2) {
    consequences.push("HOLD_RETAINED", "FOLIO_CONTINUES", "INVOICES_NOT_SUPERSEDED");
  }
  if (input.fromStage === Stage.S3 && input.toStage === Stage.S1) {
    consequences.push("HOLD_RELEASED", "FOLIO_CONTINUES", "INVOICES_SUPERSEDED", "CANCEL_W22_W34_TIMERS");
  }
  if (input.fromStage === Stage.S8 && input.toStage === Stage.S7) {
    consequences.push("CANCEL_CHECKOUT_TIME", "H4_REOPEN", "RETURN_TO_CHARGE_POSTING");
  }
  if (input.fromStage === Stage.S8 && input.toStage === Stage.S2) {
    consequences.push("CANCEL_CHECKOUT_TIME", "NEW_SEGMENT", "H4_REOPEN", "RATE_RENEGOTIATION");
  }
  // ============================================================================
  // Newly wired backflows (9 total, spec: SIG-S2 §1.3, SIG-S4 §3.1, SIG-S5 §1.3,
  // SIG-S7 §3.3, Part3 §3.2.4). Each carries the spec-mandated side-effects.
  // ============================================================================
  if (input.fromStage === Stage.S2 && input.toStage === Stage.S1) {
    // Date / room-type change → re-search availability. No committed hold at S2 (may have
    // speculative). Quotation supersedes on new segment.
    consequences.push("QUOTATION_SUPERSEDED", "SPECULATIVE_HOLD_RELEASED_IF_ANY", "CANCEL_W15_W2_TIMERS");
  }
  if (input.fromStage === Stage.S4 && input.toStage === Stage.S1) {
    // Post-confirmation date change → re-search. Reservation SUPERSEDED, hold released,
    // invoices superseded. Folio continues (it's still PROVISIONAL at S4).
    consequences.push("RESERVATION_SUPERSEDED", "HOLD_RELEASED", "FOLIO_CONTINUES", "INVOICES_SUPERSEDED", "CANCEL_W4_W22_W34_TIMERS");
  }
  if (input.fromStage === Stage.S4 && input.toStage === Stage.S2) {
    // Post-confirmation rate change → renegotiation. Hold RETAINED (dates unchanged),
    // reservation superseded, folio continues, invoices NOT superseded (rate delta layered).
    consequences.push("RESERVATION_SUPERSEDED", "HOLD_RETAINED", "FOLIO_CONTINUES", "INVOICES_NOT_SUPERSEDED", "CANCEL_W4_TIMERS");
  }
  if (input.fromStage === Stage.S4 && input.toStage === Stage.S3) {
    // Post-confirmation billing-model change → back to S3 for re-fixation. Hold RETAINED,
    // reservation superseded, folio continues, new BillingModelTransitionRecord expected.
    consequences.push("RESERVATION_SUPERSEDED", "HOLD_RETAINED", "FOLIO_CONTINUES", "BILLING_MODEL_REFIXATION_REQUIRED", "CANCEL_W4_TIMERS");
  }
  if (input.fromStage === Stage.S5 && input.toStage === Stage.S1) {
    // Pre-arrival config error → re-search. Hold released, reservation superseded, invoices
    // superseded, pre-arrival tasks cancelled, no-show cutoff cancelled.
    consequences.push(
      "RESERVATION_SUPERSEDED",
      "HOLD_RELEASED",
      "FOLIO_CONTINUES",
      "INVOICES_SUPERSEDED",
      "PRE_ARRIVAL_TASKS_CANCELLED",
      "CANCEL_W5_W23_W1_TIMERS",
    );
  }
  if (input.fromStage === Stage.S7 && input.toStage === Stage.S2) {
    // Mid-stay rate revision / full renegotiation. Folio stays LIVE (never reverts).
    // Rate delta will layer as new folio line after renegotiation.
    consequences.push("FOLIO_STAYS_LIVE", "RESERVATION_RATE_SNAPSHOT_REPLACE_ON_RETURN", "NEW_SEGMENT");
  }
  if (input.fromStage === Stage.S7 && input.toStage === Stage.S3) {
    // Mid-stay billing-model change. Folio stays LIVE.
    consequences.push("FOLIO_STAYS_LIVE", "BILLING_MODEL_REFIXATION_REQUIRED", "NEW_SEGMENT");
  }
  if (input.fromStage === Stage.S7 && input.toStage === Stage.S4) {
    // Mid-stay date extension. Folio stays LIVE, inventory claim extended, new night-audit
    // timers registered for the extra nights on return to S7, new CHECKOUT_TIME_W26 timer.
    consequences.push(
      "FOLIO_STAYS_LIVE",
      "INVENTORY_CLAIM_EXTENDED",
      "NIGHT_AUDIT_TIMERS_REGISTERED_FOR_EXTRA_NIGHTS",
      "NEW_SEGMENT",
      "NEW_CHECKOUT_TIME_TIMER",
    );
  }
  // Complaint / goodwill mode is any→S2; the from-stage is variable so we handle it as a
  // catch-all when the modeKey is COMPLAINT_RESOLUTION. Consequence set is stage-independent.
  if (input.reason?.startsWith("COMPLAINT_RESOLUTION") && input.toStage === Stage.S2) {
    consequences.push("COMPLAINT_RESOLUTION_INITIATED", "FOLIO_CONTINUES", "NEW_SEGMENT");
  }

  await (prisma as any).traceEvent.create({
    data: {
      eventType: "REENTRY.CONSEQUENCES_COMPUTED",
      actorId: input.actorId,
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: input.entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: input.fromStage,
      inquiryId: null,
      entryId: input.entryId,
      payload: { entryId: input.entryId, fromStage: input.fromStage, toStage: input.toStage, reason: input.reason, consequences },
      createdBy: input.actorId,
    },
  });
  return { ok: true, consequences } as const;
}

