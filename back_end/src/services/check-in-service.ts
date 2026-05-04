import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, InventoryClaimState, RoomPhysicalState, Stage } from "@prisma/client";
import {
  MissingConfigurationError,
  NotFoundError,
  OptimisticLockError,
  StageGateBlockedError,
  ValidationError,
} from "../lib/errors.js";
import * as folioService from "./folio-service.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";
import * as preArrivalService from "./pre-arrival-service.js";

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
  if (registrationConfirmed !== true) {
    throw new StageGateBlockedError("Registration must be confirmed", "REGISTRATION_INCOMPLETE");
  }
  if (keyCount == null || keyCount < 1 || !Number.isInteger(keyCount)) {
    throw new StageGateBlockedError("At least one key must be issued (keyCount >= 1)", "KEYS_NOT_ISSUED");
  }

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
        take: 1,
      },
      handoffs: { where: { handoffType: { in: [HandoffType.H1, HandoffType.H2, HandoffType.H3] } }, orderBy: { createdAt: "desc" } },
      vipArrivalNotifications: true,
    },
  });

  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S6) {
    throw new StageGateBlockedError("Entry must be at S6 to complete check-in", "NOT_AT_S6");
  }
  if (clientVersion !== entry.version) {
    throw new OptimisticLockError();
  }

  if (!entry.guestProfile?.identityVerifiedAt) {
    throw new StageGateBlockedError("Guest identity not verified", "IDENTITY_NOT_VERIFIED");
  }

  const folio = entry.folio;
  if (!folio || folio.state !== FolioState.PROVISIONAL) {
    throw new StageGateBlockedError("Folio must be PROVISIONAL before check-in completion", "FOLIO_NOT_CONVERTED");
  }

  if (!folio.advancePaymentReconciliationComplete) {
    throw new StageGateBlockedError("Advance payment not reconciled", "ADVANCE_PAYMENT_UNRECONCILED");
  }

  const assignment = entry.roomAssignments[0];
  if (!assignment) {
    throw new StageGateBlockedError("No room assignment", "NO_ROOM_ASSIGNMENT");
  }

  const room = assignment.room;
  if (room.physicalState !== RoomPhysicalState.AVAILABLE_CLEAN && room.physicalState !== RoomPhysicalState.AVAILABLE_INSPECTED) {
    throw new StageGateBlockedError("Room is not in a valid ready state at check-in", "ROOM_NOT_READY");
  }

  const h1 = entry.handoffs.find((h) => h.handoffType === HandoffType.H1);
  const isWalkIn = entry.walkInCompressed === true || !h1;
  if (!isWalkIn) {
    if (!h1 || (h1.state !== HandoffState.FULFILLED && h1.state !== HandoffState.CLOSED)) {
      throw new StageGateBlockedError("H1 must be FULFILLED or CLOSED", "H1_INVALID");
    }
  }

  const h2Latest = entry.handoffs.find((h) => h.handoffType === HandoffType.H2 && h.stageContext === Stage.S6);
  const h3Latest = entry.handoffs.find((h) => h.handoffType === HandoffType.H3 && h.stageContext === Stage.S6);
  if (h2Latest?.state === HandoffState.REJECTED || h3Latest?.state === HandoffState.REJECTED) {
    throw new StageGateBlockedError("H2 or H3 is in REJECTED state — FOM rerouting required", "HANDOFF_REJECTED");
  }

  const activeDef = room.deficientConditionRecords[0];
  const deficientNote =
    activeDef != null ? `${activeDef.category}: ${activeDef.description} (resolve by ${activeDef.resolutionDeadline.toISOString()})` : null;

  const now = new Date();
  const s6Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S6, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  const vipTier = entry.guestProfile.vipTier?.trim();
  const routing = vipTier ? ((await requireActiveConfigValue<Record<string, string[]> | undefined>(prisma, "vipNotification.routingPerTier")) ?? {}) : {};
  const ackWindows = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {};
  const h2WindowSeconds = ackWindows.h2 ?? ackWindows.H2 ?? ackWindows.handoffH2 ?? null;
  const h3WindowSeconds = ackWindows.h3 ?? ackWindows.H3 ?? ackWindows.handoffH3 ?? null;
  if ((h2WindowSeconds == null || h3WindowSeconds == null) && (vipTier || true)) {
    // SIG-S6: key must include H2 and H3 windows; treat missing as configuration failure for S6 readiness.
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
      const existingVip = await tx.vIPArrivalNotificationEvent.findFirst({ where: { entryId } });
      if (!existingVip) {
        const roles = routing[vipTier] ?? routing.DEFAULT ?? ["FOM", "GM"];
        if (roles.length === 0) {
          throw new ValidationError("vipNotification.routingPerTier has no roles for this VIP tier");
        }
        await tx.vIPArrivalNotificationEvent.create({
          data: {
            entryId,
            guestProfileId: entry.guestProfileId!,
            roomNumber: room.roomNumber,
            vipTier,
            preferences: entry.guestProfile?.preferences ?? undefined,
            specialNotes: null,
            checkInInitiatedAt: now,
            recipientRoles: roles,
            createdBy: actorId,
          },
        });
        await tx.traceEvent.create({
          data: {
            eventType: "VIP_ARRIVAL_NOTIFICATION_ISSUED",
            actorId,
            actorLevel: "L1",
            entityType: "Entry",
            entityId: entryId,
            operation: "ALERT",
            timestamp: now,
            stageContext: Stage.S6,
            inquiryId: entry.inquiryId,
            entryId,
            payload: { entryId, guestProfileId: entry.guestProfileId, vipTier, recipientRoles: roles, checkInInitiatedAt: now.toISOString() },
            createdBy: actorId,
          },
        });
      }
      const vipRow = await tx.vIPArrivalNotificationEvent.findFirst({ where: { entryId } });
      if (!vipRow) {
        throw new StageGateBlockedError("VIP Arrival notification must be issued for VIP check-in", "VIP_NOTIFICATION_NOT_ISSUED");
      }
    }

    const h2Existing = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H2, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    if (!h2Existing) {
      const slaDeadlineAt = new Date(now.getTime() + Number(h2WindowSeconds) * 1000);
      await tx.handoffRecord.create({
        data: {
          entryId,
          handoffType: HandoffType.H2,
          state: HandoffState.CREATED,
          fromRole: "FRONT_DESK",
          fromActorId: actorId,
          toRole: "HOUSEKEEPING",
          checklistContent: {
            roomNumber: room.roomNumber,
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
          deficientConditionStatus: deficientNote,
          createdBy: actorId,
          stageContext: Stage.S6,
          slaDeadlineAt,
        },
      });
    }

    const h3Existing = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H3, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    if (!h3Existing) {
      const slaDeadlineAt = new Date(now.getTime() + Number(h3WindowSeconds) * 1000);
      await tx.handoffRecord.create({
        data: {
          entryId,
          handoffType: HandoffType.H3,
          state: HandoffState.CREATED,
          fromRole: "FRONT_DESK",
          fromActorId: actorId,
          toRole: "F_AND_B",
          checklistContent: {
            guestProfileId: entry.guestProfileId,
            roomNumber: room.roomNumber,
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

    await folioService.convertToLive(tx, entryId, folio.id, actorId);

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

    if (room.currentClaimState === InventoryClaimState.CONFIRMED) {
      await tx.room.update({
        where: { id: room.id },
        data: { currentClaimState: InventoryClaimState.OCCUPIED, updatedAt: now },
      });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: room.id,
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

  return prisma.entry.findUniqueOrThrow({
    where: { id: entryId },
    include: { folio: true, guestProfile: true, handoffs: { orderBy: { createdAt: "desc" } } },
  });
}
