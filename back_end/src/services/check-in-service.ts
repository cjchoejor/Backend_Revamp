import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, InventoryClaimState, RoomPhysicalState, Stage } from "@prisma/client";
import {
  NotFoundError,
  OptimisticLockError,
  StageGateBlockedError,
  ValidationError,
} from "../lib/errors.js";
import * as folioService from "./folio-service.js";

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
  if (!h1 || (h1.state !== HandoffState.FULFILLED && h1.state !== HandoffState.CLOSED)) {
    throw new StageGateBlockedError("H1 must be FULFILLED or CLOSED", "H1_INVALID");
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
  const routingCfg = await prisma.configurationEntry.findUnique({ where: { configKey: "vipNotification.routingPerTier" } });
  const routing = (routingCfg?.value as Record<string, string[]> | undefined) ?? {};

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
      }
    }

    const h2Existing = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H2, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    if (!h2Existing) {
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
        },
      });
    }

    const h3Existing = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H3, stageContext: Stage.S6 },
      orderBy: { createdAt: "desc" },
    });
    if (!h3Existing) {
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
          },
          createdBy: actorId,
          stageContext: Stage.S6,
        },
      });
    }

    await folioService.convertToLive(tx, entryId, folio.id, actorId);

    if (h1.state === HandoffState.FULFILLED) {
      await tx.handoffRecord.update({
        where: { id: h1.id },
        data: { state: HandoffState.CLOSED, closedAt: now },
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
      await tx.stageDwellRecord.update({
        where: { id: s6Dwell.id },
        data: { exitedAt: now },
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
  });

  return prisma.entry.findUniqueOrThrow({
    where: { id: entryId },
    include: { folio: true, guestProfile: true, handoffs: { orderBy: { createdAt: "desc" } } },
  });
}
