import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, InventoryClaimState, Stage } from "@prisma/client";
import {
  MissingConfigurationError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from "../../lib/errors.js";
import * as folioService from "./folio-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import * as preArrivalService from "./pre-arrival-service.js";
import { enforceRoomAssignmentPresentForCheckInCompletion, enforceRoomPhysicalReadyForS6CheckInCompletion } from "../../policies/01-availability/p01-room-assignment-and-physical-ready-s6-checkin.js";
import { enforceH1EligibleForS6CheckInCompletion } from "../../policies/02-ownership-custodian-assignment/p05-h1-eligible-for-s6-checkin-completion.js";
import { enforceIdentityVerifiedBeforeCheckInCompletion } from "../../policies/06-guest-identity/p16-identity-verified-before-checkin-completion.js";
import { enforceKeyCountIssuedForCheckInCompletion, enforceRegistrationConfirmedForCheckInCompletion } from "../../policies/06-guest-identity/p16-checkin-completion-ceremony-gates.js";
import { enforceAdvancePaymentReconciledBeforeCheckInCompletion } from "../../policies/12-advance-payment/p29-advance-payment-reconciled-before-checkin-completion.js";
import { enforceFolioProvisionalBeforeCheckInCompletion } from "../../policies/13-billing-model/p31-folio-provisional-before-checkin-completion.js";
import { enforceVipArrivalNotificationRecordedForCheckInCompletion } from "../../policies/20-communication-acknowledgement-tracking/p52-vip-arrival-notification-recorded-for-checkin.js";
import { enforceH2H3NotRejectedAtS6CheckIn } from "../../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceEntryAtS6ForCheckInCompletionToS7 } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { scheduleS7StageDwellWarningMonitor } from "../../lib/schedule-s7-dwell-warning-monitor.js";
import { readHandoffChecklistContent } from "../../lib/handoff-checklist.js";

export async function completeCheckInToS7(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  clientVersion: number | undefined,
  keyCount: number | undefined,
  registrationConfirmed: boolean | undefined,
) {
  if (clientVersion == null) {
    throw new ValidationError("version is required for check-in completion");
  }
  enforceRegistrationConfirmedForCheckInCompletion({ registrationConfirmed });
  enforceKeyCountIssuedForCheckInCompletion({ keyCount });

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      guestProfile: true,
      reservation: true,
      preArrivalTasks: true,
      roomAssignments: {
        include: { room: { include: { deficientConditionRecords: { where: { status: "UNRESOLVED" } } } } },
        orderBy: { createdAt: "desc" },
      },
      handoffs: { where: { handoffType: { in: [HandoffType.H1, HandoffType.H2, HandoffType.H3] } }, orderBy: { createdAt: "desc" } },
    },
  });

  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS6ForCheckInCompletionToS7({ currentStage: entry.currentStage });
  if (clientVersion !== entry.version) {
    throw new OptimisticLockError();
  }

  enforceIdentityVerifiedBeforeCheckInCompletion({ identityVerifiedAt: entry.guestProfile?.identityVerifiedAt });

  enforceFolioProvisionalBeforeCheckInCompletion({ folio: entry.folio });
  enforceAdvancePaymentReconciledBeforeCheckInCompletion({
    advancePaymentReconciliationComplete: !!entry.folio?.advancePaymentReconciliationComplete,
  });

  // Batching rule: whenever the entry has multiple distinct room assignments, check in all
  // of them together. Historically this was keyed on groupBillingMode === "GROUP_MASTER",
  // but that misses legitimate multi-room bookings below the group threshold (e.g. 2 rooms
  // for 4 guests never hits GROUP_MASTER but still needs both rooms checked in). Dedup by
  // roomId so an entry with a room-change history doesn't double-process the same room.
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
  const assignmentsToCheckIn =
    distinctAssignments.length > 1 ? distinctAssignments : entry.roomAssignments.slice(0, 1);
  const assignment = assignmentsToCheckIn[0];
  enforceRoomAssignmentPresentForCheckInCompletion({ assignment });

  const room = assignment.room;
  // Every room being checked in must be physically ready. Fail-fast if any room isn't —
  // the operator has to make them all ready before batched check-in (otherwise we'd have
  // partial success with confusing state).
  for (const a of assignmentsToCheckIn) {
    enforceRoomPhysicalReadyForS6CheckInCompletion({ physicalState: a.room.physicalState });
  }

  const h1 = entry.handoffs.find((h) => h.handoffType === HandoffType.H1);
  enforceH1EligibleForS6CheckInCompletion({ walkInCompressed: entry.walkInCompressed, h1 });
  const isWalkIn = entry.walkInCompressed === true || !h1;

  // Loophole 5 fix: per-room H2/H3 rejection check. For group entries with multiple rooms,
  // the reject-check must consider EACH room's own H2/H3 handoff — not just the latest at
  // the entry level. Rejection on room A shouldn't block check-in of rooms B and C if their
  // handoffs are fine, and rejection on any one room should still block that room. We
  // enforce per-room; if ANY room has a rejected H2/H3, the whole batch fails (safer than
  // silently proceeding with the un-rejected rooms).
  const perRoomHandoffs = new Map<
    string,
    { h2?: (typeof entry.handoffs)[number]; h3?: (typeof entry.handoffs)[number] }
  >();
  for (const h of entry.handoffs) {
    if (h.stageContext !== Stage.S6) continue;
    // Prefer the new FK; fall back to matching by roomNumber in checklistContent so legacy
    // rows created before the migration still work.
    const contentRoomNumber = readHandoffChecklistContent(h.checklistContent).roomNumber;
    const roomKey = h.roomAssignmentId ?? (contentRoomNumber ? `by-room-number:${contentRoomNumber}` : null);
    if (!roomKey) continue;
    const entryForRoom = perRoomHandoffs.get(roomKey) ?? {};
    if (h.handoffType === HandoffType.H2) entryForRoom.h2 = h;
    if (h.handoffType === HandoffType.H3) entryForRoom.h3 = h;
    perRoomHandoffs.set(roomKey, entryForRoom);
  }
  for (const [, { h2, h3 }] of perRoomHandoffs) {
    enforceH2H3NotRejectedAtS6CheckIn({ h2State: h2?.state, h3State: h3?.state });
  }

  const activeDef = room.deficientConditionRecords[0];
  const deficientNote =
    activeDef != null ? `${activeDef.category}: ${activeDef.description} (resolve by ${activeDef.resolutionDeadline.toISOString()})` : null;

  const now = new Date();
  const s6Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S6, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  const vipTier = entry.guestProfile?.vipTier?.trim();
  const ackWindows = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {};
  const h2WindowSeconds = ackWindows.h2 ?? ackWindows.H2 ?? ackWindows.handoffH2 ?? null;
  const h3WindowSeconds = ackWindows.h3 ?? ackWindows.H3 ?? ackWindows.handoffH3 ?? null;
  if (h2WindowSeconds == null || h3WindowSeconds == null) {
    throw new MissingConfigurationError("acknowledgement.windowPerType");
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (isWalkIn) {
      // Walk-in compressed path: seed tasks if missing, waive time-dependent ones, record no-H1 path and S5 auto-fulfilment.
      await preArrivalService.initialiseTasks(tx as any, entryId, actorId);

      const tasks = await tx.preArrivalTask.findMany({ where: { entryId } });
      const waiveTypes = new Set([
        "PRE_ARRIVAL_COMMUNICATION",
        "BED_CONFIGURATION_CHANGE",
        "SPECIAL_REQUEST_FULFILMENT",
        "LATE_ARRIVAL_MEAL_COORDINATION",
        "SITE_VISIT",
      ]);

      for (const t of tasks) {
        if (t.status !== "PENDING") continue;
        if (waiveTypes.has(t.taskType as any)) {
          await tx.preArrivalTask.update({
            where: { id: t.id },
            data: { status: "WAIVED", waivedReason: "WALK_IN_COMPRESSED", waivedBy: actorId },
          });
        }
        if ((t.taskType as any) === "UNIT_READINESS_VERIFICATION") {
          await tx.preArrivalTask.update({
            where: { id: t.id },
            data: { status: "COMPLETE", completedAt: now, completedBy: actorId },
          });
        }
      }

      await tx.traceEvent.create({
        data: {
          eventType: "WALK_IN.NO_H1_PATH",
          actorId,
          actorLevel: "L1",
          entityType: "Entry",
          entityId: entryId,
          operation: "INFO",
          timestamp: now,
          stageContext: Stage.S6,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, reason: "WALK_IN_COMPRESSED" },
          createdBy: actorId,
        },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "WALK_IN.S5_AUTO_FULFILLED",
          actorId,
          actorLevel: "L1",
          entityType: "Entry",
          entityId: entryId,
          operation: "TRANSITION",
          timestamp: now,
          stageContext: Stage.S6,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, waivedReason: "WALK_IN_COMPRESSED" },
          createdBy: actorId,
        },
      });
    }

    if (vipTier) {
      const vipRow = await tx.vIPArrivalNotificationEvent.findFirst({ where: { entryId } });
      enforceVipArrivalNotificationRecordedForCheckInCompletion({ vipTier, hasVipArrivalNotification: !!vipRow });
    }

    // Create one H2 (housekeeping) and one H3 (F&B) per room being checked in. Dedup
    // primarily via the new `roomAssignmentId` FK; fall back to matching by roomNumber in
    // checklistContent so pre-migration rows keep working. Non-group entries have a
    // single-item assignmentsToCheckIn list so this collapses to the historical behaviour.
    const existingH2s = await tx.handoffRecord.findMany({
      where: { entryId, handoffType: HandoffType.H2, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    const existingH3s = await tx.handoffRecord.findMany({
      where: { entryId, handoffType: HandoffType.H3, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    const matchesAssignment = (
      h: (typeof existingH2s)[number],
      a: (typeof assignmentsToCheckIn)[number],
    ): boolean => {
      if (h.roomAssignmentId === a.id) return true;
      const contentRoomNumber = readHandoffChecklistContent(h.checklistContent).roomNumber;
      return h.roomAssignmentId == null && contentRoomNumber === a.room.roomNumber;
    };

    for (const a of assignmentsToCheckIn) {
      const perRoomDeficient = a.room.deficientConditionRecords[0];
      const perRoomDeficientNote =
        perRoomDeficient != null
          ? `${perRoomDeficient.category}: ${perRoomDeficient.description} (resolve by ${perRoomDeficient.resolutionDeadline.toISOString()})`
          : null;

      const alreadyH2 = existingH2s.some((h) => matchesAssignment(h, a));
      if (!alreadyH2) {
        const slaDeadlineAt = new Date(now.getTime() + Number(h2WindowSeconds) * 1000);
        const h2Id = await allocateReadableId(tx, "HANDOFF" as const, now);
        await tx.handoffRecord.create({
          data: {
            id: h2Id,
            entryId,
            roomAssignmentId: a.id,
            handoffType: HandoffType.H2,
            state: HandoffState.CREATED,
            fromRole: "FRONT_DESK",
            fromActorId: actorId,
            toRole: "HOUSEKEEPING",
            checklistContent: {
              roomNumber: a.room.roomNumber,
              guestProfileId: entry.guestProfileId,
              expectedStayNights: Math.max(
                1,
                Math.ceil(
                  ((entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? now).getTime() -
                    (entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? now).getTime()) /
                    86400000,
                ),
              ),
            },
            deficientConditionStatus: perRoomDeficientNote,
            createdBy: actorId,
            stageContext: Stage.S6,
            slaDeadlineAt,
          },
        });
      }

      const alreadyH3 = existingH3s.some((h) => matchesAssignment(h, a));
      if (!alreadyH3) {
        const slaDeadlineAt = new Date(now.getTime() + Number(h3WindowSeconds) * 1000);
        const h3Id = await allocateReadableId(tx, "HANDOFF" as const, now);
        await tx.handoffRecord.create({
          data: {
            id: h3Id,
            entryId,
            roomAssignmentId: a.id,
            handoffType: HandoffType.H3,
            state: HandoffState.CREATED,
            fromRole: "FRONT_DESK",
            fromActorId: actorId,
            toRole: "F_AND_B",
            checklistContent: {
              guestProfileId: entry.guestProfileId,
              roomNumber: a.room.roomNumber,
              guestCount: entry.reservation?.frozenGuestCount ?? entry.guestCount ?? 1,
              mealPlan: "per reservation inclusions",
              dietaryRequirements: (entry.guestProfile?.preferences as any)?.dietaryRequirements ?? null,
              packageInclusions: (entry.reservation?.frozenInclusions as any) ?? {},
              stayDuration: {
                checkInDate: (entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? now).toISOString(),
                checkOutDate: (entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? now).toISOString(),
              },
              cuisinePreferences: (entry.guestProfile?.preferences as any)?.cuisinePreferences ?? null,
            },
            createdBy: actorId,
            stageContext: Stage.S6,
            slaDeadlineAt,
          },
        });
      }
    }

    await folioService.convertToLive(tx, entryId, entry.folio!.id, actorId);

    if (h1 && h1.state === HandoffState.FULFILLED) {
      await tx.handoffRecord.update({
        where: { id: h1.id },
        data: { state: HandoffState.CLOSED, closedAt: now },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "HANDOFF.H1_CLOSED",
          actorId,
          actorLevel: "L1",
          entityType: "HandoffRecord",
          entityId: h1.id,
          operation: "TRANSITION",
          timestamp: now,
          stageContext: Stage.S6,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { handoffId: h1.id, entryId },
          createdBy: actorId,
        },
      });
    }

    // Every room being checked in transitions CONFIRMED → OCCUPIED. For non-group entries
    // there's only one assignment in the list; for groups this fires per room. Rooms not in
    // CONFIRMED state (already OCCUPIED from a prior check-in, or in an unexpected state)
    // are skipped rather than force-transitioned — the physical-ready guard above already
    // rejected anything obviously wrong, so this branch is defensive.
    for (const a of assignmentsToCheckIn) {
      if (a.room.currentClaimState !== InventoryClaimState.CONFIRMED) continue;
      await tx.room.update({
        where: { id: a.room.id },
        data: { currentClaimState: InventoryClaimState.OCCUPIED, updatedAt: now },
      });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: a.room.id,
          entryId,
          fromState: InventoryClaimState.CONFIRMED,
          toState: InventoryClaimState.OCCUPIED,
          actorId,
          reason: "CHECK_IN",
          effectiveFrom: now,
        },
      });
    }

    if (s6Dwell) {
      const dwellMs = now.getTime() - s6Dwell.enteredAt.getTime();
      const dwellSeconds = Math.max(0, Math.floor(dwellMs / 1000));
      await tx.stageDwellRecord.update({
        where: { id: s6Dwell.id },
        data: { exitedAt: now, dwellSeconds },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S7, enteredAt: now },
    });

    await tx.entry.update({
      where: { id: entryId },
      data: {
        currentStage: Stage.S7,
        version: { increment: 1 },
        keysIssuedAt: now,
        keysIssuedCount: keyCount,
        keysIssuedBy: actorId,
        registrationCompletedAt: now,
        registrationCompletedBy: actorId,
        updatedAt: now,
      },
    });

    if (!vipTier) {
      await tx.traceEvent.create({
        data: {
          eventType: "CHECK_IN.ESCORT_COMPLETE",
          actorId,
          actorLevel: "L1",
          entityType: "Entry",
          entityId: entryId,
          operation: "ALERT",
          timestamp: now,
          stageContext: Stage.S6,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, roomNumber: room.roomNumber, note: "non_VIP_arrival escort" },
          createdBy: actorId,
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "CHECK_IN.KEYS_ISSUED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, keyCount, afterIdentityVerified: true },
        createdBy: actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "CHECK_IN_COMPLETE",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, toStage: "S7", keyCount, afterKeysIssued: true },
        createdBy: actorId,
      },
    });
  });

  // Register W25 acceptance timers (best-effort) for latest H2/H3 created during this check-in.
  const engine = await getTimerEngine();
  const created = await prisma.handoffRecord.findMany({
    where: { entryId, stageContext: Stage.S6, handoffType: { in: [HandoffType.H2, HandoffType.H3] } },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  for (const h of created) {
    if (!h.slaDeadlineAt) continue;
    const existingTimer = await prisma.timerRecord.findFirst({
      where: { entityType: "HandoffRecord", entityId: h.id, timerCode: "H2_H3_ACCEPTANCE_W25", status: "SCHEDULED" },
    });
    if (existingTimer) continue;
    const jobId = await engine.schedule("H2_H3_ACCEPTANCE_W25", { handoffId: h.id }, { startAfter: h.slaDeadlineAt });
    await prisma.timerRecord.create({
      data: {
        entryId,
        entityType: "HandoffRecord",
        entityId: h.id,
        timerType: "H2_H3_ACCEPTANCE_W25",
        timerCode: "H2_H3_ACCEPTANCE_W25",
        stageContext: Stage.S6,
        firesAt: h.slaDeadlineAt,
        dueAt: h.slaDeadlineAt,
        status: "SCHEDULED",
        payload: { handoffId: h.id, entryId },
        pgBossJobId: jobId,
        createdBy: "SYSTEM",
      },
    });
  }

  try {
    await scheduleS7StageDwellWarningMonitor(prisma, entryId, actorId);
  } catch {
    // Best-effort dwell monitor scheduling.
  }

  return prisma.entry.findUniqueOrThrow({
    where: { id: entryId },
    include: { folio: true, guestProfile: true, handoffs: { orderBy: { createdAt: "desc" } } },
  });
}
