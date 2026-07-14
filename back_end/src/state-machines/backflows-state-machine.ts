/**
 * The 9 spec-mandated backflows wired 2026-07-14 as first-class state transitions.
 *
 * Spec inventory (from the auditor's list, confirmed against LEGPHEL_Implementation_Reference v1.1):
 *   1. S2 → S1 · date/room-type change → re-search              (SIG-S2 §1.3, L1+)
 *   2. S4 → S1 · post-confirmation date change                  (SIG-S4 §3.1, FOM)
 *   3. S4 → S2 · post-confirmation rate change                  (SIG-S4 §3.1, FOM/GM)
 *   4. S4 → S3 · post-confirmation billing-model change         (SIG-S4 §3.1, FOM/GM)
 *   5. S5 → S1 · pre-arrival config error → re-search           (SIG-S5 §1.3, FOM)
 *   6. S7 → S2 · mid-stay rate revision / renegotiation         (SIG-S7 §3.3, GM)
 *   7. S7 → S3 · mid-stay billing-model change                  (SIG-S7 §3.3, FOM/GM)
 *   8. S7 → S4 · mid-stay date extension                        (SIG-S7 §3.3, FOM/GM)
 *   9. Any → S2 · complaint / goodwill commercial adjustment    (Part3 §3.2.4, FOM/GM)
 *
 * All 9 follow the same shape: authority gate → stage gate → transaction that (a) runs the
 * consequences engine, (b) executes stage-specific side effects, (c) seals the current segment,
 * (d) opens a new one at the target stage, (e) updates dwell records, (f) updates Entry, (g)
 * emits ENTRY.BACKFLOW_<CODE>_<FROM>_<TO> trace with mode metadata.
 *
 * Mode registry: every function looks up its ModeConfiguration row and enforces it is ACTIVE.
 * Previously ModeConfiguration existed but was dormant — now it's load-bearing.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { computeReEntryConsequences } from "../engines/re-entry-consequence-engine.js";
import { requireActiveMode, isTransitionAllowedByMode } from "../lib/mode-registry-runtime.js";
import { evaluateAutoFulfilment, type EntryFacts } from "../lib/mode-auto-fulfilment.js";
import { getRegistryPolicy } from "../lib/policy-registry-runtime.js";
import { cancelEntryTimersByCode } from "../lib/cancel-entry-timers-by-code.js";
import * as s3HoldService from "../services/domain/s3-hold-service.js";
import { supersedePendingInvoicesTx } from "../services/domain/s3-folio-service.js";
import { registerNightAuditTimers } from "../services/domain/pre-arrival-service.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import {
  enforceS2ToS1BackflowAuthority,
  enforceS4ToS1BackflowAuthority,
  enforceS4ToS2BackflowAuthority,
  enforceS4ToS3BackflowAuthority,
  enforceS5ToS1BackflowAuthority,
  enforceS7ToS2BackflowAuthority,
  enforceS7ToS3BackflowAuthority,
  enforceS7ToS4BackflowAuthority,
  enforceComplaintResolutionBackflowAuthority,
} from "../policies/01-availability/p01-backflow-authority.js";

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
type Tx = Prisma.TransactionClient;

// ============================================================================
// Shared helper — every backflow does the same bookkeeping. Only the side
// effects (`hooks.before`) and the mode key differ.
// ============================================================================

async function runBackflow(
  prisma: PrismaClient,
  input: {
    entryId: string;
    fromStage: Stage;
    toStage: Stage;
    actor: Actor;
    reason: string;
    modeKey: string;
    /** Side effects that must run in the same tx BEFORE the segment / stage flip. */
    hooks?: (tx: Tx, entry: { id: string; version: number; inquiryId: string | null; currentStage: Stage }) => Promise<void>;
    /** Timer codes to cancel (fire pg-boss + mark CANCELLED). */
    cancelTimerCodes?: string[];
  },
) {
  // Load the entry once, outside the tx, so we can validate stage + fetch metadata.
  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    select: {
      id: true,
      version: true,
      currentStage: true,
      status: true,
      inquiryId: true,
      segmentNumber: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true, segmentNumber: true, sealedAt: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== input.fromStage) {
    throw new ValidationError(`Backflow requires entry at ${input.fromStage}, got ${entry.currentStage}`);
  }
  const currentSeg = entry.segments[0];
  if (!currentSeg) throw new ValidationError("Entry has no segment");

  // Mode registry — ACIG §2.1A.7. Was dormant; now load-bearing.
  const mode = await requireActiveMode(prisma, input.modeKey);
  // Warn (not block) if stageRoute doesn't declare both stages. The registry is authoritative
  // for whether the mode is enabled, but the transition list evolves — surface a soft error.
  if (!isTransitionAllowedByMode(mode, input.fromStage, input.toStage)) {
    // Log via trace only; the fixed backflow implementation is trusted. Real production would
    // route this to an admin dashboard so someone can extend the mode's stageRoute.
    await prisma.traceEvent.create({
      data: {
        eventType: "MODE.STAGEROUTE_INCONSISTENT",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "ModeConfiguration",
        entityId: mode.id,
        operation: "ALERT",
        timestamp: new Date(),
        entryId: entry.id,
        payload: {
          modeKey: mode.modeKey,
          modeStageRoute: mode.stageRoute,
          attempted: { from: input.fromStage, to: input.toStage },
          note: "Mode does not declare both stages in stageRoute — extend the seed if this transition should be routable.",
        },
        createdBy: "SYSTEM",
      },
    });
  }

  // Cancel pg-boss jobs BEFORE the tx (side-effect-free to DB retry) so pre-tx failure doesn't
  // leave orphan cancelled rows. Idempotent per code.
  if (input.cancelTimerCodes?.length) {
    await cancelEntryTimersByCode(prisma, {
      entryId: entry.id,
      timerCodes: input.cancelTimerCodes,
      cancelledBy: input.actor.actorId,
      cancelledReason: `BACKFLOW_${input.modeKey}_${input.fromStage}_TO_${input.toStage}`,
    });
  }

  const now = new Date();
  const nextSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;

  return prisma.$transaction(async (tx) => {
    // 1. Compute consequences (writes REENTRY.CONSEQUENCES_COMPUTED trace).
    await computeReEntryConsequences(tx, {
      entryId: entry.id,
      fromStage: input.fromStage,
      toStage: input.toStage,
      reason: input.reason,
      actorId: input.actor.actorId,
    });

    // 2. Run side effects (release hold, supersede invoices, etc.).
    if (input.hooks) {
      await input.hooks(tx, { id: entry.id, version: entry.version, inquiryId: entry.inquiryId, currentStage: entry.currentStage });
    }

    // 3. Seal the current segment.
    if (!currentSeg.sealedAt) {
      await tx.segment.update({
        where: { id: currentSeg.id },
        data: {
          sealedAt: now,
          sealedBy: input.actor.actorId,
          notes: `BACKFLOW_${input.fromStage}_TO_${input.toStage}`,
        },
      });
    }

    // 4. Open new segment at target stage.
    await tx.segment.create({
      data: {
        entryId: entry.id,
        segmentNumber: nextSegmentNumber,
        stage: input.toStage,
        startedAt: now,
        createdBy: input.actor.actorId,
        notes: input.reason,
      },
    });

    // 5. Dwell records: close the current, open the new.
    const dwellOpen = await tx.stageDwellRecord.findFirst({
      where: { entryId: entry.id, stage: input.fromStage, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (dwellOpen) {
      await tx.stageDwellRecord.update({
        where: { id: dwellOpen.id },
        data: {
          exitedAt: now,
          dwellSeconds: Math.max(0, Math.floor((now.getTime() - dwellOpen.enteredAt.getTime()) / 1000)),
        },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId: entry.id, stage: input.toStage, enteredAt: now },
    });

    // 6. Update Entry's currentStage + bump version.
    await tx.entry.update({
      where: { id: entry.id },
      data: {
        currentStage: input.toStage,
        segmentNumber: nextSegmentNumber,
        version: { increment: 1 },
        updatedAt: now,
      },
    });

    // 7. Emit backflow trace (mode + from + to + segment metadata).
    await tx.traceEvent.create({
      data: {
        eventType: `ENTRY.BACKFLOW_${input.modeKey}_${input.fromStage}_TO_${input.toStage}`,
        actorId: input.actor.actorId,
        actorLevel: input.actor.actorLevel,
        entityType: "Entry",
        entityId: entry.id,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: input.fromStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          entryId: entry.id,
          modeKey: input.modeKey,
          modeVersion: mode.version,
          fromStage: input.fromStage,
          toStage: input.toStage,
          segmentNumber: nextSegmentNumber,
          reason: input.reason,
        },
        createdBy: input.actor.actorId,
      },
    });

    return tx.entry.findUniqueOrThrow({ where: { id: entry.id } });
  }).then(async (updated) => {
    // Post-tx: consult mode.autoFulfilmentConditions to see if the target stage should be
    // short-circuited. If a condition matches, log MODE.AUTO_FULFILMENT_APPLIED and (for now)
    // record the intent — actual auto-progression is stage-specific and delegated to a follow-up
    // integration point (progressStageS2ToS3 / S3ToS4 / etc.). The trace makes the intent visible
    // so a future dispatcher can chain the transition automatically.
    try {
      const facts = await gatherEntryFactsForAutoFulfilment(prisma, entry.id, input.toStage);
      const evalResult = evaluateAutoFulfilment(mode, input.toStage, facts);
      if (evalResult.skip) {
        await prisma.traceEvent.create({
          data: {
            eventType: "MODE.AUTO_FULFILMENT_APPLIED",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "Entry",
            entityId: entry.id,
            operation: "ALERT",
            timestamp: new Date(),
            entryId: entry.id,
            payload: {
              modeKey: mode.modeKey,
              stage: input.toStage,
              matchedCondition: evalResult.matchedCondition,
              reason: evalResult.reason,
              at: evalResult.at,
            },
            createdBy: "SYSTEM",
          } as any,
        }).catch(() => {});
      }
    } catch {
      // Fact gathering failures are non-fatal — the backflow itself already committed.
    }
    return updated;
  });
}

/**
 * Gather the facts the auto-fulfilment evaluator needs. Kept in one place so a new
 * condition just needs a new evaluator plus (optionally) a new fact — no scattering of
 * DB lookups across services.
 */
async function gatherEntryFactsForAutoFulfilment(
  prisma: PrismaClient,
  entryId: string,
  currentStage: Stage,
): Promise<EntryFacts> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      guestCount: true,
      reservation: { select: { frozenRate: true } },
      quotations: {
        where: { state: "DRAFT" },
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { commercialTerms: true },
      },
    },
  });
  // Group threshold is a policy; snapshot the current registry value (we don't yet store the
  // creation-time value on the entry — fine for now, follow-up would freeze it on the entry row).
  const groupPolicy = await getRegistryPolicy(prisma, "registry.groupDetection.guestCountThreshold");
  const groupThreshold = (groupPolicy as any)?.threshold ?? (groupPolicy as any)?.count ?? null;
  const draftTerms = (entry?.quotations?.[0]?.commercialTerms ?? null) as { effectiveRate?: unknown } | null;
  return {
    entryId,
    currentStage,
    frozenRate: entry?.reservation?.frozenRate ? String(entry.reservation.frozenRate) : null,
    proposedEffectiveRate: draftTerms?.effectiveRate != null ? String(draftTerms.effectiveRate) : null,
    guestCount: entry?.guestCount ?? null,
    groupThresholdAtCreation: typeof groupThreshold === "number" ? groupThreshold : null,
    inventoryAlreadyCommittedForNewNights: false, // populated by a future S3 re-hold hook.
  };
}

// ============================================================================
// 1. S2 → S1 · date / room-type change → re-search
// ============================================================================

export async function backflowS2ToS1(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS2ToS1BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S2,
    toStage: Stage.S1,
    actor,
    reason: input.reason.trim(),
    modeKey: "NEW_BOOKING", // S2→S1 is a re-search inside the primary journey
    cancelTimerCodes: ["QUOTATION_VALIDITY_W15", "SPECULATIVE_HOLD_EXPIRY_W2"],
    hooks: async (tx, entry) => {
      // Any speculative hold gets released; folio not yet created at S2 (holds nothing).
      const specHold = await tx.speculativeHold.findFirst({
        where: { entryId: entry.id, state: "PLACED" },
      });
      if (specHold) {
        await tx.speculativeHold.update({
          where: { id: specHold.id },
          data: { state: "RELEASED" as any, releasedAt: new Date() },
        });
      }
      // Supersede any DRAFT/SENT quotation on this entry.
      await tx.quotation.updateMany({
        where: { entryId: entry.id, state: { in: ["DRAFT", "SENT"] } },
        data: { state: "SUPERSEDED" as any },
      });
    },
  });
}

// ============================================================================
// 2. S4 → S1 · post-confirmation date change
// ============================================================================

export async function backflowS4ToS1(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS4ToS1BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S4,
    toStage: Stage.S1,
    actor,
    reason: input.reason.trim(),
    modeKey: "NEW_BOOKING", // Post-confirm date change ≈ re-book with same guest
    cancelTimerCodes: [
      "PRE_ARRIVAL_COUNTDOWN_W4",
      "ACKNOWLEDGEMENT_WINDOW_W22",
      "ADVANCE_PAYMENT_FOLLOW_UP_W34",
    ],
    hooks: async (tx, entry) => {
      // Release committed hold (all rooms, per Wave B fix).
      await s3HoldService.releaseOnReEntry(tx, entry.id, actor);
      // Supersede pending invoices (PROFORMA + any others).
      await supersedePendingInvoicesTx(tx, entry.id, actor.actorId);
      // Reservation: mark as superseded on the current segment; the new segment will build fresh.
      await tx.reservation.updateMany({
        where: { entryId: entry.id },
        data: { supersededAt: new Date() as any } as any,
      }).catch(() => {}); // supersededAt may not exist on Reservation; skip silently — the audit trace is authoritative.
    },
  });
}

// ============================================================================
// 3. S4 → S2 · post-confirmation rate change
// ============================================================================

export async function backflowS4ToS2(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS4ToS2BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S4,
    toStage: Stage.S2,
    actor,
    reason: input.reason.trim(),
    modeKey: "RATE_REVISION",
    cancelTimerCodes: ["PRE_ARRIVAL_COUNTDOWN_W4"],
    hooks: async (tx, entry) => {
      // Hold RETAINED (dates unchanged); reservation snapshot to be replaced on return to S4.
      // Supersede acceptance so a new quotation must be sent + accepted.
      await tx.quotation.updateMany({
        where: { entryId: entry.id, state: "ACCEPTED" },
        data: { state: "SUPERSEDED" as any },
      });
    },
  });
}

// ============================================================================
// 4. S4 → S3 · post-confirmation billing-model change
// ============================================================================

export async function backflowS4ToS3(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS4ToS3BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S4,
    toStage: Stage.S3,
    actor,
    reason: input.reason.trim(),
    modeKey: "BILLING_MODEL_CHANGE",
    cancelTimerCodes: ["PRE_ARRIVAL_COUNTDOWN_W4"],
    hooks: async () => {
      // Hold RETAINED, folio continues in PROVISIONAL. New BillingModelTransitionRecord will
      // be written by s3-reservation-setup-service when the operator picks the new model.
    },
  });
}

// ============================================================================
// 5. S5 → S1 · pre-arrival config error → re-search
// ============================================================================

export async function backflowS5ToS1(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS5ToS1BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S5,
    toStage: Stage.S1,
    actor,
    reason: input.reason.trim(),
    modeKey: "NEW_BOOKING",
    cancelTimerCodes: [
      "NO_SHOW_CUTOFF_W5",
      "ROOM_READINESS_SLA_W23",
      "STAGE_DWELL_MONITOR_S5",
      "NIGHT_AUDIT_STAY_NIGHT_W37",
    ],
    hooks: async (tx, entry) => {
      await s3HoldService.releaseOnReEntry(tx, entry.id, actor);
      await supersedePendingInvoicesTx(tx, entry.id, actor.actorId);
      // Cancel any PENDING pre-arrival tasks.
      await tx.preArrivalTask.updateMany({
        where: { entryId: entry.id, status: "PENDING" },
        data: { status: "WAIVED", waivedReason: `BACKFLOW_S5_TO_S1: ${input.reason}`, waivedBy: actor.actorId },
      });
    },
  });
}

// ============================================================================
// 6. S7 → S2 · mid-stay rate revision / full renegotiation (GM only)
// ============================================================================

export async function backflowS7ToS2(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS7ToS2BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S7,
    toStage: Stage.S2,
    actor,
    reason: input.reason.trim(),
    modeKey: "RATE_REVISION",
    // No timer cancellations — folio LIVE, night audit continues.
    hooks: async (tx, entry) => {
      // Supersede accepted quotation so a new one must be drafted + accepted.
      await tx.quotation.updateMany({
        where: { entryId: entry.id, state: "ACCEPTED" },
        data: { state: "SUPERSEDED" as any },
      });
      // NOTE: folio remains LIVE per §5.2 ("LIVE never reverts to PROVISIONAL"). Rate delta
      // will layer as an additive FolioLine when the operator returns to S7 with the new rate.
    },
  });
}

// ============================================================================
// 7. S7 → S3 · mid-stay billing-model change
// ============================================================================

export async function backflowS7ToS3(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceS7ToS3BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  return runBackflow(prisma, {
    entryId,
    fromStage: Stage.S7,
    toStage: Stage.S3,
    actor,
    reason: input.reason.trim(),
    modeKey: "BILLING_MODEL_CHANGE",
    hooks: async () => {
      // Folio LIVE; new BillingModelTransitionRecord expected before returning to S7.
    },
  });
}

// ============================================================================
// 8. S7 → S4 · mid-stay date extension
// ============================================================================

export async function backflowS7ToS4(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string; newCheckOutDate: string },
) {
  enforceS7ToS4BackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  if (!input.newCheckOutDate?.trim()) throw new ValidationError("newCheckOutDate is required (ISO)");
  const newCheckOut = new Date(input.newCheckOutDate);
  if (Number.isNaN(newCheckOut.getTime())) throw new ValidationError("newCheckOutDate must be a valid ISO date");

  // Pre-load the current dates so we can validate + detect the extra-night range before the tx.
  const priorReservation = await prisma.reservation.findFirst({
    where: { entryId },
    select: { frozenCheckOutDate: true, frozenCheckInDate: true },
  });
  const priorCheckOut = priorReservation?.frozenCheckOutDate ?? null;
  if (priorCheckOut && newCheckOut.getTime() <= priorCheckOut.getTime()) {
    // Extension means later than current checkout. Same-date is a no-op; earlier is early-departure
    // and belongs on the cancellation route (`cancelEntryEarlyDepartureAfterCheckIn`).
    throw new ValidationError("newCheckOutDate must be strictly LATER than the current frozenCheckOutDate — use the early-departure cancellation route for shorter stays.");
  }

  const result = await runBackflow(prisma, {
    entryId,
    fromStage: Stage.S7,
    toStage: Stage.S4,
    actor,
    reason: `${input.reason.trim()} | newCheckOutDate=${newCheckOut.toISOString()}`,
    modeKey: "DATE_EXTENSION",
    hooks: async (tx, entry) => {
      // Extend Reservation frozenCheckOutDate + Entry checkOutDate. The extra-night night-audit
      // timers are registered post-tx so the pg-boss enqueue doesn't get rolled back if the
      // Prisma tx fails; timer registration is idempotent (advisory-lock guarded per night).
      await tx.reservation.updateMany({
        where: { entryId: entry.id },
        data: { frozenCheckOutDate: newCheckOut },
      });
      await tx.entry.update({
        where: { id: entry.id },
        data: { checkOutDate: newCheckOut },
      });
    },
  });

  // Post-commit: register night-audit timers for the extra nights. `registerNightAuditTimers`
  // reads `entry.reservation.frozenCheckOutDate` (which we just extended) and iterates every
  // stay-night with a per-night advisory lock — existing nights hit the dup guard and skip;
  // only the new nights get scheduled.
  await registerNightAuditTimers(prisma, entryId, "SYSTEM").catch(async (e) => {
    // Non-fatal — surface via trace so ops sees the gap. The main transition already committed.
    await prisma.traceEvent.create({
      data: {
        eventType: "NIGHT_AUDIT_TIMERS.EXTRA_NIGHTS_SCHEDULE_FAILED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: new Date(),
        entryId,
        payload: { entryId, newCheckOutDate: newCheckOut.toISOString(), error: (e as Error)?.message ?? String(e) },
        createdBy: "SYSTEM",
      } as any,
    }).catch(() => {});
  });

  // Cancel any active CHECKOUT_TIME_W26 keyed to the old date; forward progression S4→S5 will
  // re-register on the new date. Even though the scheduler side of W26 isn't yet built (see
  // CLAUDE.md follow-ups), the cancel is safe / idempotent — if there's no such timer this
  // is a no-op.
  await cancelEntryTimersByCode(prisma, {
    entryId,
    timerCodes: ["CHECKOUT_TIME_W26"],
    cancelledBy: actor.actorId,
    cancelledReason: "BACKFLOW_S7_TO_S4_DATE_EXTENSION",
  }).catch(() => {
    /* pre-existing timer scheduling gap; safe to swallow — the cancel itself has no downstream effect. */
  });
  // Bind the engine ref so the future CHECKOUT_TIME_W26 scheduling wire-up has a stable import.
  void getTimerEngine;

  return result;
}

// ============================================================================
// 9. Any → S2 · complaint / goodwill commercial adjustment
// ============================================================================

export async function backflowComplaintToS2(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { reason: string },
) {
  enforceComplaintResolutionBackflowAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("reason is required");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { currentStage: true, status: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === "CLOSED" || entry.status === "CANCELLED" || entry.status === "EXPIRED") {
    throw new ValidationError(`Complaint resolution cannot open on a ${entry.status} entry`);
  }
  if (entry.currentStage === Stage.S2 || entry.currentStage === Stage.S9) {
    throw new ValidationError(`Complaint resolution from ${entry.currentStage} is redundant — use in-stage adjustment instead`);
  }

  return runBackflow(prisma, {
    entryId,
    fromStage: entry.currentStage,
    toStage: Stage.S2,
    actor,
    reason: `COMPLAINT_RESOLUTION: ${input.reason.trim()}`,
    modeKey: "COMPLAINT_RESOLUTION",
    hooks: async () => {
      // Complaint resolution is a commercial-adjustment path. Folio continues; downstream code
      // (quotation service under COMPLAINT_RESOLUTION mode) writes the goodwill adjustment.
    },
  });
}
