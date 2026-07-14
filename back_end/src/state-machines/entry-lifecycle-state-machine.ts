import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, Stage } from "@prisma/client";
import { NotFoundError, OptimisticLockError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getRegistryPolicy } from "../lib/policy-registry-runtime.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import { allocateReadableId } from "../lib/readable-id.js";
import { scheduleS6StageDwellWarningMonitor } from "../lib/schedule-s6-dwell-warning-monitor.js";
import { cancelScheduledRoomReadinessSlaForEntry } from "../services/domain/room-assignment-service.js";
import { issueVipArrivalNotificationAtCommencementTx } from "../services/domain/vip-arrival-notification-service.js";
import * as checkInService from "../services/domain/check-in-service.js";
import * as disputeService from "../services/domain/s7-dispute-service.js";
import { releaseCommittedHoldForRoomChange } from "../services/domain/s3-hold-service.js";
import { loadEntryDetail } from "../lib/entry-detail-include.js";
import { enforceDisputeGateAllowsProgress } from "../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";
import { enforceNoPendingPreArrivalTasks } from "../policies/03-expiry-parking/p09-s5-normal-exit-pre-arrival-tasks-terminal.js";
import { enforceCreditCeilingTier2Acknowledged } from "../policies/18-credit-extension-ceiling/p44-credit-ceiling-proximity-check.js";
import { enforceH1FulfilledBeforeCheckIn } from "../policies/02-ownership-custodian-assignment/p05-h1-fulfilled-required-for-checkin.js";
import { enforceNotAwaitingWrittenConfirmation } from "../policies/22-no-show/p56-awaiting-written-confirmation-blocks-s5-exit.js";
import { enforceAdvancePaymentReconciliationComplete } from "../policies/12-advance-payment/p28-s5-advance-payment-reconciliation-required.js";
import { enforceAssignedRoomPhysicalReadinessForArrival } from "../policies/01-availability/p01-assigned-room-physical-readiness-for-arrival.js";
import { enforceDeficientAssignmentDocumented } from "../policies/19-deficient-condition/p48-deficient-room-assignment-decision.js";
import { enforceGuestPhysicallyPresentForS5ToS6 } from "../policies/06-guest-identity/p16-guest-physically-present-s5-to-s6.js";
import { enforceRoomAssignmentPresentForS5ToS6 } from "../policies/01-availability/p01-room-assignment-present-s5-to-s6.js";
import { enforceFolioProvisionalForS5ToS6 } from "../policies/13-billing-model/p31-folio-provisional-required-s5-to-s6.js";
import { enforceConferenceGroupWorkOrderTodosCompleteForS5ToS6 } from "../policies/27-work-order/p67-s5-work-order-todos-complete-for-checkin.js";
import { enforceDeficientRecordsHaveTerminalStatusForS7ToS8 } from "../policies/19-deficient-condition/p51-deficient-final-status-before-s7-to-s8.js";
import { enforceCheckoutDatePresentForS7ToS8, enforceOccupiedRoomAssignmentForS7ToS8 } from "../policies/01-availability/p01-s7-exit-room-and-checkout-gates.js";
import { enforceH4InitiatedBeforeS7ToS8UnlessSameDayDeparture } from "../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceNightAuditCompleteForLastOperatingDateBeforeS7ToS8 } from "../policies/24-night-audit/p61-night-audit-complete-before-s7-to-s8.js";
import { enforceNoUnresolvedNightAuditAnomaliesForS7ToS8 } from "../policies/24-night-audit/p60-unresolved-night-audit-anomalies-for-s7-to-s8.js";
import {
  enforceEntryAtS5ForS5ToS6Progression,
  enforceEntryAtS6ForS6ToS1ReEntry,
  enforceEntryAtS7ForS7ToS8Progression,
} from "../policies/01-availability/p01-entry-progression-stage-gates.js";

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

/** SIG-S5 — S5 → S6 (guest at desk; pre-arrival gates). Folio stays PROVISIONAL. */
export async function progressStageS5ToS6(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  clientVersion: number | undefined,
  guestPhysicallyPresent: boolean | undefined,
) {
  if (clientVersion == null || clientVersion === undefined) {
    throw new OptimisticLockError();
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      guestProfile: true,
      reservation: true,
      folio: true,
      handoffs: { where: { handoffType: HandoffType.H1 }, orderBy: { createdAt: "desc" }, take: 1 },
      preArrivalTasks: true,
      // Multi-room: fetch ALL room assignments so the gate below iterates every room's
      // readiness (was `take: 1` which only checked the first room).
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" } },
    },
  });

  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS5ForS5ToS6Progression({ currentStage: entry.currentStage });

  await enforceConferenceGroupWorkOrderTodosCompleteForS5ToS6(prisma, { entryId, useType: entry.useType });

  if (clientVersion !== entry.version) {
    throw new OptimisticLockError();
  }

  enforceGuestPhysicallyPresentForS5ToS6({ guestPhysicallyPresent });

  const awaitingTimer = await prisma.timerRecord.findFirst({
    where: { entryId, timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  enforceNotAwaitingWrittenConfirmation({ hasAwaitingWrittenConfirmationTimer: !!awaitingTimer });

  const h1 = entry.handoffs[0];
  enforceH1FulfilledBeforeCheckIn({ hasH1: !!h1, h1State: h1?.state });

  // Multi-room: dedup by roomId and enforce readiness gates on EVERY room. Fail-fast if any
  // one room is not ready — the whole S5→S6 transition holds until all rooms clear.
  const distinctAssignments = (() => {
    const seen = new Set<string>();
    const list: typeof entry.roomAssignments = [];
    for (const a of entry.roomAssignments) {
      if (seen.has(a.roomId)) continue;
      seen.add(a.roomId);
      list.push(a);
    }
    return list;
  })();
  const assignment = distinctAssignments[0];
  enforceRoomAssignmentPresentForS5ToS6({ assignment });

  const arrival = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  for (const a of distinctAssignments) {
    enforceAssignedRoomPhysicalReadinessForArrival({
      physicalState: a.room.physicalState,
      expectedReadyAt: a.room.expectedReadyAt,
      arrivalAt: arrival,
    });
    enforceDeficientAssignmentDocumented({
      deficientAtAssignment: a.deficientAtAssignment,
      acknowledgementActorId: a.acknowledgementActorId,
      acknowledgementAt: a.acknowledgementAt,
    });
  }
  const room = assignment.room;

  enforceNoPendingPreArrivalTasks({ tasks: entry.preArrivalTasks.map((t) => ({ status: t.status, taskType: t.taskType })) });

  enforceFolioProvisionalForS5ToS6({ folio: entry.folio });
  const folio = entry.folio!;

  enforceAdvancePaymentReconciliationComplete({ isReconciled: !!folio.advancePaymentReconciliationComplete });

  await enforceCreditCeilingTier2Acknowledged(prisma, {
    ceilingAmount: entry.reservation?.creditCeilingIfExtended != null ? num(entry.reservation.creditCeilingIfExtended) : null,
    outstandingBalance: num(folio.outstandingBalance),
    hasTier2Acknowledgement: !!entry.creditCeilingTier2AcknowledgedAt,
  });

  const now = new Date();
  const s5Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S5, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  const vipTier = entry.guestProfile?.vipTier?.trim() ?? "";
  let routingPerTier: Record<string, string[]> = {};
  let vipAckWindowSeconds = 3600;
  if (vipTier) {
    if (!entry.guestProfileId) {
      throw new ValidationError("Guest profile is required for VIP check-in commencement");
    }
    // Policy registry override: `registry.vip.notificationRoutingPerTier` (SIG-S6 §9, blocking
    // for S6_READINESS) — when enabled and `tiers` is a record-of-string-arrays — supplies the
    // routing map. Otherwise falls back to the legacy `vipNotification.routingPerTier`
    // ConfigurationEntry. Either source must yield a non-empty map; otherwise the downstream
    // VIP notification service raises a ValidationError.
    const vipRoutingPolicy = await getRegistryPolicy(prisma, "registry.vip.notificationRoutingPerTier");
    const registryTiers =
      vipRoutingPolicy &&
      vipRoutingPolicy.enabled !== false &&
      vipRoutingPolicy.tiers &&
      typeof vipRoutingPolicy.tiers === "object" &&
      !Array.isArray(vipRoutingPolicy.tiers)
        ? (vipRoutingPolicy.tiers as Record<string, string[]>)
        : null;
    routingPerTier =
      registryTiers ?? (await requireActiveConfigValue<Record<string, string[]>>(prisma, "vipNotification.routingPerTier"));
    // Policy registry override: `registry.vipArrivalAck.seconds` takes precedence over the
    // legacy `acknowledgement.windowPerType.vipArrival` sub-key when enabled.
    const vipAckPolicy = await getRegistryPolicy(prisma, "registry.vipArrivalAck.seconds");
    const registryVipAck =
      vipAckPolicy && vipAckPolicy.enabled !== false && typeof vipAckPolicy.seconds === "number"
        ? (vipAckPolicy.seconds as number)
        : null;
    if (registryVipAck !== null) {
      vipAckWindowSeconds = registryVipAck;
    } else {
      const ackWindowsRaw = (await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType").catch(() => ({}))) ?? {};
      const ackWindows = ackWindowsRaw as Record<string, number>;
      vipAckWindowSeconds = Number(ackWindows.vipArrival ?? ackWindows.VIP_ARRIVAL ?? 3600);
    }
    if (!Number.isFinite(vipAckWindowSeconds) || vipAckWindowSeconds < 60) {
      vipAckWindowSeconds = 3600;
    }
  }

  await prisma.$transaction(async (tx) => {
    if (s5Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s5Dwell.id },
        data: { exitedAt: now },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S6, enteredAt: now },
    });
    await tx.entry.update({
      where: { id: entryId },
      data: {
        currentStage: Stage.S6,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.STAGE_TRANSITION",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, fromStage: "S5", toStage: "S6" },
        createdBy: actorId,
      },
    });

    if (vipTier && entry.guestProfileId) {
      const roomNumber = entry.roomAssignments[0]?.room?.roomNumber ?? "";
      if (!roomNumber) {
        throw new ValidationError("Room assignment with room number is required for VIP arrival notification at commencement");
      }
      await issueVipArrivalNotificationAtCommencementTx(
        tx,
        {
          entryId,
          inquiryId: entry.inquiryId,
          guestProfileId: entry.guestProfileId,
          vipTier,
          roomNumber,
          preferences: entry.guestProfile?.preferences ?? null,
          actorId,
          routingPerTier,
        },
        vipAckWindowSeconds,
      );
    }
  });

  await cancelScheduledRoomReadinessSlaForEntry(prisma, entryId, actorId, "GUEST_ARRIVED_S5_TO_S6");
  try {
    await scheduleS6StageDwellWarningMonitor(prisma, entryId, actorId);
  } catch {
    // non-blocking: dwell thresholds may be absent in some environments
  }
  if (vipTier) {
    // VIP arrival notification is load-bearing — a silent swallow left staff with no VIP ping.
    // Log the schedule failure to a trace so ops can spot the gap; entry progression itself
    // must not be blocked by pg-boss unavailability.
    try {
      const engine = await getTimerEngine();
      await engine.schedule("VIP_ARRIVAL_NOTIFICATION_W14", { entryId }, { startAfter: new Date(Date.now() + 1500) });
    } catch (e) {
      await prisma.traceEvent.create({
        data: {
          eventType: "VIP.ARRIVAL_NOTIFICATION_SCHEDULE_FAILED",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "Entry",
          entityId: entryId,
          operation: "ALERT",
          timestamp: new Date(),
          entryId,
          payload: { entryId, vipTier, error: (e as Error)?.message ?? String(e) },
          createdBy: "SYSTEM",
        } as any,
      }).catch(() => {});
    }
  }

  return loadEntryDetail(prisma, entryId);
}

/** SIG-S6 §8.2 — S6 → S7 (check-in completion: folio LIVE, OCCUPIED, H2/H3, keys, registration). */
export async function progressStageS6ToS7(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  clientVersion: number | undefined,
  keyCount: number | undefined,
  registrationConfirmed: boolean | undefined,
) {
  return checkInService.completeCheckInToS7(prisma, entryId, actorId, clientVersion, keyCount, registrationConfirmed);
}

/** SIG-S6 §5.2 / AC-S6-036 — S6→S1 re-entry (room change at check-in). A reason is recorded as an
 *  AmendmentEventRecord and traced; the new room is chosen fresh at S1. */
export async function reEnterS6ToS1(prisma: PrismaClient, entryId: string, actorId: string, reason?: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      roomAssignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: true } },
      handoffs: { where: { handoffType: { in: [HandoffType.H2, HandoffType.H3] }, stageContext: Stage.S6 }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS6ForS6ToS1ReEntry({ currentStage: entry.currentStage });

  const now = new Date();
  const nextSegmentNumber = entry.segmentNumber + 1;
  const handoffIds = entry.handoffs.map((h) => h.id);
  const room = entry.roomAssignments[0]?.room;

  await prisma.$transaction(async (tx) => {
    // Cancel H2/H3 for original assignment context.
    if (handoffIds.length > 0) {
      await tx.handoffRecord.updateMany({
        where: { id: { in: handoffIds }, state: { in: [HandoffState.CREATED, HandoffState.ACCEPTED, HandoffState.ESCALATED, HandoffState.REJECTED, HandoffState.FULFILLED] } },
        data: { state: HandoffState.CANCELLED, cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S6_TO_S1" },
      });
      await tx.timerRecord.updateMany({
        where: { entityType: "HandoffRecord", entityId: { in: handoffIds }, timerCode: "H2_H3_ACCEPTANCE_W25", status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S6_TO_S1" },
      });
    }

    // Release original room claim (CONFIRMED/OCCUPIED → FREE).
    if (room && room.currentClaimState !== "FREE") {
      const fromState = room.currentClaimState;
      await tx.room.update({ where: { id: room.id }, data: { currentClaimState: "FREE", updatedAt: now } });
      await tx.roomClaimStateEvent.create({
        data: { roomId: room.id, entryId, fromState: fromState as any, toState: "FREE", actorId, reason: "REENTRY_S6_TO_S1", effectiveFrom: now },
      });
    }

    // Erase the committed hold bound to the old room (any state) so the old room is fully released
    // and a fresh hold can be placed for the newly chosen room at S3. Traced for audit.
    await releaseCommittedHoldForRoomChange(tx, entryId, { actorId, actorLevel: "L1" }, "REENTRY_S6_TO_S1", entry.inquiryId);

    // Unseal any sealed availability configs so re-progression at S1 forces a fresh room selection.
    // Without this, the prior sealed config (pointing at the OLD room) propagates to the S3
    // committed-hold placement, causing the hold to bind to the old room while the new assignment
    // is for the new room — a divergence that blocks S8 settlement ("Room must be OCCUPIED").
    await tx.availabilityConfiguration.updateMany({
      where: { entryId, sealedAt: { not: null } },
      data: { sealedAt: null },
    });

    const newSegment = await tx.segment.create({
      data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S1, startedAt: now, createdBy: actorId, notes: "REENTRY_S6_TO_S1" },
    });

    // Record the room-change request reason in a relatable table for audit/history.
    const changeReason = reason?.trim() || "Room change requested at check-in";
    const amendmentId = await allocateReadableId(tx, "AMENDMENT" as const, now);
    await tx.amendmentEventRecord.create({
      data: {
        id: amendmentId,
        entryId,
        segmentId: newSegment.id,
        amendmentPath: "PATH_1",
        amendmentType: "ROOM_CHANGE",
        requestedBy: actorId,
        authorisedBy: actorId,
        authorityBasis: "S6 room change re-entry",
        reason: changeReason,
        newTermsSummary: `Room change requested at check-in (from room ${room?.roomNumber ?? "—"}); new room to be selected at S1`,
        stageAtAmendment: Stage.S6,
        affectsGroup: entry.groupBillingMode === "GROUP_MASTER",
      },
    });

    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S1, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.REENTRY_S6_TO_S1",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, toStage: "S1", segmentNumber: nextSegmentNumber, reason: changeReason, fromRoomId: room?.id ?? null, cancelledHandoffIds: handoffIds },
        createdBy: actorId,
      },
    });
  });

  return loadEntryDetail(prisma, entryId);
}

/** SIG-S7 — S7 → S8 (exit stay to checkout prep). */
export async function progressStageS7ToS8(prisma: PrismaClient, entryId: string, _actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null) {
    throw new ValidationError("version is required for S7→S8 progression");
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      reservation: true,
      // Multi-room: all room assignments so the OCCUPIED gate below enforces every room.
      roomAssignments: { orderBy: { createdAt: "desc" }, include: { room: true } },
      handoffs: { where: { handoffType: HandoffType.H4 }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS7ForS7ToS8Progression({ currentStage: entry.currentStage });
  if (entry.version !== clientVersion) throw new OptimisticLockError();

  // Every distinct room must be OCCUPIED for the entry to progress to S8. Deficient records
  // are checked across ALL rooms — any room with a stuck non-terminal record blocks.
  const distinctAssignmentsForS7 = (() => {
    const seen = new Set<string>();
    const list: typeof entry.roomAssignments = [];
    for (const a of entry.roomAssignments) {
      if (seen.has(a.roomId)) continue;
      seen.add(a.roomId);
      list.push(a);
    }
    return list;
  })();
  const assignment = distinctAssignmentsForS7[0];
  enforceOccupiedRoomAssignmentForS7ToS8({ assignment });
  for (const a of distinctAssignmentsForS7) {
    enforceOccupiedRoomAssignmentForS7ToS8({ assignment: a });
  }

  const deficient = await prisma.deficientConditionRecord.findMany({
    where: { roomId: { in: distinctAssignmentsForS7.map((a) => a.roomId) } },
  });
  const bad = deficient.find((d) => d.status !== "RESOLVED" && d.status !== "UNRESOLVED");
  enforceDeficientRecordsHaveTerminalStatusForS7ToS8({ hasDeficientWithoutFinalStatus: !!bad });

  const h4 = entry.handoffs[0];
  const checkoutForH4 = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  const nowForH4 = new Date();
  const isSameDayDeparture = checkoutForH4 ? checkoutForH4.toISOString().slice(0, 10) === nowForH4.toISOString().slice(0, 10) : false;
  const h4Valid = !!(h4 && ["CREATED", "ACCEPTED", "FULFILLED"].includes(String(h4.state)) && !h4.rejectedAt);
  enforceH4InitiatedBeforeS7ToS8UnlessSameDayDeparture({ h4Valid, isSameDayDeparture });

  const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  enforceCheckoutDatePresentForS7ToS8({ checkout });
  const lastNight = new Date(Date.UTC(checkout!.getUTCFullYear(), checkout!.getUTCMonth(), checkout!.getUTCDate() - 1, 0, 0, 0, 0));
  const audit = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: lastNight } });
  enforceNightAuditCompleteForLastOperatingDateBeforeS7ToS8({ nightAudit: audit });

  const unresolvedAnomalyCount = await prisma.nightAuditAnomaly.count({
    where: { entryId, resolvedAt: null },
  });
  enforceNoUnresolvedNightAuditAnomaliesForS7ToS8({ unresolvedCount: unresolvedAnomalyCount });

  const disputeGate = await disputeService.canProgressToS8(prisma, entryId);
  enforceDisputeGateAllowsProgress({
    gateResult: disputeGate,
    messageWhenBlockedWithOverride: "Dispute gate blocks S7→S8 until GM override is recorded",
  });

  const now = new Date();
  const s7Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S7, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  await prisma.$transaction(async (tx) => {
    // If H4 missing but same-day departure, auto-create + auto-fulfil (AC-S7-16).
    if (!h4 || !["CREATED", "ACCEPTED", "FULFILLED"].includes(h4.state) || h4.rejectedAt) {
      const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
      const today = now.toISOString().slice(0, 10);
      const isSameDayDeparture = checkout ? checkout.toISOString().slice(0, 10) === today : false;
      if (isSameDayDeparture) {
        const h4Id = await allocateReadableId(tx, "HANDOFF" as const, now);
        const created = await tx.handoffRecord.create({
          data: {
            id: h4Id,
            entryId,
            handoffType: HandoffType.H4,
            state: "FULFILLED",
            fromRole: "FRONT_DESK",
            fromActorId: _actorId ?? "SYSTEM",
            toRole: "HOUSEKEEPING",
            checklistContent: { auto: true } as any,
            fulfilmentEvidence: { autoFulfilled: true, basis: "SAME_DAY_DEPARTURE" } as any,
            fulfilledAt: now,
            fulfilledBy: "SYSTEM",
            isAutoFulfilled: true,
            createdBy: _actorId ?? "SYSTEM",
            stageContext: Stage.S7,
          } as any,
        });
        await tx.traceEvent.create({
          data: {
            eventType: "HANDOFF.H4_AUTO_FULFILLED",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "HandoffRecord",
            entityId: created.id,
            operation: "TRANSITION",
            timestamp: now,
            stageContext: Stage.S7,
            inquiryId: entry.inquiryId,
            entryId,
            payload: { handoffId: created.id, entryId, basis: "SAME_DAY_DEPARTURE" },
            createdBy: "SYSTEM",
          },
        });
      }
    }
    if (s7Dwell) await tx.stageDwellRecord.update({ where: { id: s7Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S8, enteredAt: now } });
    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S8, version: { increment: 1 }, updatedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.STAGE_TRANSITION",
        actorId: _actorId ?? "SYSTEM",
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, fromStage: "S7", toStage: "S8" },
        createdBy: _actorId ?? "SYSTEM",
      },
    });

    // AC-S7-14: if exiting S7 with an unresolved deficient condition, mark it as unresolved-at-checkout.
    await tx.deficientConditionRecord.updateMany({
      where: { roomId: assignment.roomId, status: "UNRESOLVED" },
      data: { status: "DEFICIENT_UNRESOLVED_AT_CHECKOUT" },
    });
  });

  return loadEntryDetail(prisma, entryId);
}
