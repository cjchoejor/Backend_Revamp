import type { Prisma, PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as paymentService from "./s3-payment-service.js";
import { enforceFocValidationForCommittedHold } from "../../policies/15-foc/p38-foc-validation-for-committed-hold.js";
import { enforceCommittedHoldInventoryAvailable } from "../../policies/11-committed-hold/p26-committed-hold-inventory-availability.js";
import { enforceCancellationDisclosurePresent } from "../../policies/14-cancellation/p34-cancellation-terms-disclosure-required.js";
import { enforceAdvancePaymentSatisfiedOrCreditExtensionPresent } from "../../policies/18-credit-extension-ceiling/p42-advance-payment-or-credit-extension-required.js";
import { enforceCommittedHoldReleaseOnReEntryAuthority } from "../../policies/11-committed-hold/p26-committed-hold-release-on-reentry-requires-fom.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import { enforceFolioPresentBeforeCommittedHoldS3 } from "../../policies/13-billing-model/p31-folio-required-before-committed-hold-s3.js";

export async function placeCommittedHold(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { roomId: string; commercialJustification: string; isFoc?: boolean; roomsRequested?: number; focRoomsRequested?: number },
) {
  if (!input.roomId?.trim()) throw new ValidationError("roomId is required");
  if (!input.commercialJustification?.trim()) throw new ValidationError("commercialJustification is required");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, folio: true, cancellationDisclosure: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  enforceCancellationDisclosurePresent({ hasCancellationDisclosure: !!entry.cancellationDisclosure });

  enforceFolioPresentBeforeCommittedHoldS3({ folio: entry.folio });

  const payment = await paymentService.evaluateAdvancePaymentCondition(prisma, { entryId, folioId: entry.folio!.id });
  enforceAdvancePaymentSatisfiedOrCreditExtensionPresent({ isAdvancePaymentSatisfied: payment.satisfied });

  const useType = String((entry as any).useType ?? "");
  await enforceFocValidationForCommittedHold(prisma, {
    entryId,
    useType,
    isFoc: input.isFoc === true,
    roomsRequested: Number(input.roomsRequested ?? 1),
    focRoomsRequested: Number(input.focRoomsRequested ?? 1),
  });

  const ttlSeconds = await requireActiveConfigValue<number>(prisma, "expiry.s3.committedHoldTtlSeconds").catch(() => {
    throw new MissingConfigurationError("expiry.s3.committedHoldTtlSeconds");
  });

  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) throw new NotFoundError("Room");
  enforceCommittedHoldInventoryAvailable({ currentClaimState: room.currentClaimState });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(ttlSeconds) * 1000);

  return prisma.$transaction(async (tx) => {
    // Upgrade speculative hold if present on this segment/room.
    const spec = await tx.speculativeHold.findFirst({
      where: { entryId, segmentId, roomId: input.roomId, state: HoldState.PLACED },
      orderBy: { placedAt: "desc" },
    });

    await tx.room.update({
      where: { id: input.roomId },
      data: { currentClaimState: InventoryClaimState.COMMITTED_HELD },
    });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: input.roomId,
        entryId,
        fromState: room.currentClaimState,
        toState: InventoryClaimState.COMMITTED_HELD,
        actorId: actor.actorId,
        reason: spec ? "COMMITTED_HOLD_UPGRADE_FROM_SPECULATIVE" : "COMMITTED_HOLD_PLACED",
        effectiveFrom: now,
      },
    });

    const hold = await tx.committedHold.upsert({
      where: { entryId },
      create: {
        entryId,
        segmentId,
        roomId: input.roomId,
        roomTypeId: room.roomTypeId,
        state: HoldState.PLACED,
        placedAt: now,
        placedBy: actor.actorId,
        commercialJustification: input.commercialJustification.trim(),
        ttlSeconds: Number(ttlSeconds),
        expiresAt,
      },
      update: {
        segmentId,
        roomId: input.roomId,
        roomTypeId: room.roomTypeId,
        state: HoldState.PLACED,
        placedAt: now,
        placedBy: actor.actorId,
        commercialJustification: input.commercialJustification.trim(),
        ttlSeconds: Number(ttlSeconds),
        expiresAt,
      },
    });

    const engine = await getTimerEngine();
    const jobId = await engine.schedule("COMMITTED_HOLD_EXPIRY_W3", { committedHoldId: hold.id }, { startAfter: expiresAt });
    await tx.timerRecord.create({
      data: {
        entryId,
        entityType: "CommittedHold",
        entityId: hold.id,
        timerType: "COMMITTED_HOLD_EXPIRY_W3",
        timerCode: "COMMITTED_HOLD_EXPIRY_W3",
        stageContext: Stage.S3,
        firesAt: expiresAt,
        dueAt: expiresAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        payload: { committedHoldId: hold.id },
        createdBy: actor.actorId,
      },
    });

    if (spec) {
      await tx.speculativeHold.update({ where: { id: spec.id }, data: { state: HoldState.UPGRADED, upgradedToId: hold.id } });
      // cancel speculative hold timer(s)
      const specTimers = await tx.timerRecord.findMany({
        where: { entityType: "SpeculativeHold", entityId: spec.id, status: "SCHEDULED" },
        select: { id: true, pgBossJobId: true },
      });
      await Promise.all(specTimers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
      await tx.timerRecord.updateMany({
        where: { id: { in: specTimers.map((t) => t.id) } },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "UPGRADED_TO_COMMITTED" },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "COMMITTED_HOLD.PLACED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CommittedHold",
        entityId: hold.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { committedHoldId: hold.id, roomId: input.roomId, expiresAt: expiresAt.toISOString(), upgradedFromSpeculative: !!spec },
        createdBy: actor.actorId,
      },
    });

    return hold;
  });
}

export async function releaseOnReEntry(
  prisma: PrismaClient | Prisma.TransactionClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  enforceCommittedHoldReleaseOnReEntryAuthority({ actorLevel: actor.actorLevel });
  const tx = prisma as any;
  const hold = await tx.committedHold.findUnique({ where: { entryId } });
  if (!hold) throw new NotFoundError("CommittedHold");
  if (hold.state !== HoldState.PLACED) return hold;
  const now = new Date();

  if (hold.roomId) {
    const room = await tx.room.findUnique({ where: { id: hold.roomId } });
    if (room) {
      await tx.room.update({ where: { id: hold.roomId }, data: { currentClaimState: InventoryClaimState.FREE } });
      await tx.roomClaimStateEvent.create({
        data: { roomId: hold.roomId, entryId, fromState: InventoryClaimState.COMMITTED_HELD, toState: InventoryClaimState.FREE, actorId: actor.actorId, reason: "REENTRY_S3_TO_S1_HOLD_RELEASED", effectiveFrom: now },
      });
    }
  }

  const engine = await getTimerEngine();
  const timers = await tx.timerRecord.findMany({ where: { entityType: "CommittedHold", entityId: hold.id, status: "SCHEDULED" }, select: { id: true, pgBossJobId: true } });
  await Promise.all(timers.map((t: any) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({ where: { id: { in: timers.map((t: any) => t.id) } }, data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "REENTRY_S3_TO_S1" } as any });

  const updated = await tx.committedHold.update({ where: { id: hold.id }, data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: actor.actorId, releaseReason: "REENTRY_S3_TO_S1" } });

  await tx.traceEvent.create({
    data: {
      eventType: "HOLD.RELEASED_ON_REENTRY",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "CommittedHold",
      entityId: hold.id,
      operation: "RELEASE",
      timestamp: now,
      stageContext: Stage.S3,
      entryId,
      payload: { entryId, committedHoldId: hold.id, releaseReason: "REENTRY_S3_TO_S1" },
      createdBy: actor.actorId,
    },
  });

  return updated;
}

