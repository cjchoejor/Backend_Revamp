import type { PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";
import * as paymentService from "./s3-payment-service.js";

export async function placeCommittedHold(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { roomId: string; commercialJustification: string },
) {
  if (!input.roomId?.trim()) throw new ValidationError("roomId is required");
  if (!input.commercialJustification?.trim()) throw new ValidationError("commercialJustification is required");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, folio: true, cancellationDisclosure: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S3) throw new StageGateBlockedError("Entry must be at S3", "NOT_AT_S3");
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  if (!entry.cancellationDisclosure) {
    throw new PolicyGateBlockedError("CANCELLATION_DISCLOSURE_REQUIRED", "Cancellation disclosure is required before committed hold");
  }

  if (!entry.folio) {
    throw new StageGateBlockedError("Folio required before committed hold", "MISSING_FOLIO");
  }

  const payment = await paymentService.evaluateAdvancePaymentCondition(prisma, { entryId, folioId: entry.folio.id });
  if (!payment.satisfied) {
    throw new PolicyGateBlockedError("ADVANCE_PAYMENT_NOT_SATISFIED", "Advance payment threshold not satisfied (credit extension required)");
  }

  const ttlSeconds = await requireActiveConfigValue<number>(prisma, "expiry.s3.committedHoldTtlSeconds").catch(() => {
    throw new MissingConfigurationError("expiry.s3.committedHoldTtlSeconds");
  });

  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) throw new NotFoundError("Room");
  if (room.currentClaimState !== InventoryClaimState.FREE && room.currentClaimState !== InventoryClaimState.SPECULATIVELY_HELD) {
    throw new PolicyGateBlockedError("INVENTORY_NOT_AVAILABLE", "Room is not available for committed hold");
  }

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

