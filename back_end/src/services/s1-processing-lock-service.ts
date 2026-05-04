import type { PrismaClient } from "@prisma/client";
import { ProcessingLockStatus } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";

export async function placeLock(
  prisma: PrismaClient,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { inventoryReference: string; channel: "EMAIL_AI" | "WHATSAPP_AI" | "FRONT_DESK" | "PHONE"; entryContext?: { entryId: string; segmentId?: string } },
) {
  if (!input.inventoryReference?.trim()) throw new ValidationError("inventoryReference is required");
  if (!input.channel?.trim()) throw new ValidationError("channel is required");

  const ttlMap = await requireActiveConfigValue<Record<string, number>>(prisma, "processingLock.ttl.perChannel");
  const ttlSeconds = Number(ttlMap[input.channel]);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) throw new ValidationError(`processingLock.ttl.perChannel missing/invalid for channel ${input.channel}`);

  const placedAt = new Date();
  const expiresAt = new Date(placedAt.getTime() + ttlSeconds * 1000);

  const prior = await prisma.processingLockRecord.findFirst({
    where: { inventoryReference: input.inventoryReference, status: ProcessingLockStatus.ACTIVE },
    orderBy: { placedAt: "desc" },
  });

  const created = await prisma.$transaction(async (tx) => {
    const lock = await tx.processingLockRecord.create({
      data: {
        actorId: actor.actorId,
        channel: input.channel,
        inventoryReference: input.inventoryReference,
        entryId: input.entryContext?.entryId ?? null,
        segmentId: input.entryContext?.segmentId ?? null,
        placedAt,
        ttlSeconds,
        expiresAt,
        status: ProcessingLockStatus.ACTIVE,
        pgBossJobId: null,
      },
    });

    const engine = await getTimerEngine();
    const actualJobId = await engine.schedule("PROCESSING_LOCK_TTL", { lockId: lock.id }, { startAfter: expiresAt });
    await tx.processingLockRecord.update({ where: { id: lock.id }, data: { pgBossJobId: actualJobId } });

    await tx.traceEvent.create({
      data: {
        eventType: "PROCESSING_LOCK.PLACED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "ProcessingLockRecord",
        entityId: lock.id,
        operation: "CREATE",
        timestamp: placedAt,
        stageContext: null,
        inquiryId: null,
        entryId: lock.entryId,
        payload: { lockId: lock.id, inventoryReference: lock.inventoryReference, channel: lock.channel, expiresAt: lock.expiresAt.toISOString() },
        createdBy: actor.actorId,
      },
    });

    return lock;
  });

  return {
    lock: created,
    meta: prior ? { priorityNotice: `Existing active lock detected: ${prior.id}` } : {},
  };
}

export async function reconfirm(prisma: PrismaClient, actorId: string, expiredLockId: string) {
  if (!expiredLockId?.trim()) throw new ValidationError("id is required");
  const old = await prisma.processingLockRecord.findUnique({ where: { id: expiredLockId } });
  if (!old) throw new NotFoundError("ProcessingLockRecord");
  if (old.status !== ProcessingLockStatus.EXPIRED) {
    throw new StateTransitionError("Lock must be EXPIRED to reconfirm");
  }

  const ttlMap = await requireActiveConfigValue<Record<string, number>>(prisma, "processingLock.ttl.perChannel");
  const ttlSeconds = Number(ttlMap[old.channel]);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) throw new ValidationError(`processingLock.ttl.perChannel missing/invalid for channel ${old.channel}`);

  const placedAt = new Date();
  const expiresAt = new Date(placedAt.getTime() + ttlSeconds * 1000);

  const out = await prisma.$transaction(async (tx) => {
    const lock = await tx.processingLockRecord.create({
      data: {
        actorId: old.actorId,
        channel: old.channel,
        inventoryReference: old.inventoryReference,
        entryId: old.entryId,
        segmentId: old.segmentId,
        placedAt,
        ttlSeconds,
        expiresAt,
        status: ProcessingLockStatus.ACTIVE,
        revalidationCount: old.revalidationCount + 1,
        pgBossJobId: null,
      },
    });
    const engine = await getTimerEngine();
    const actualJobId = await engine.schedule("PROCESSING_LOCK_TTL", { lockId: lock.id }, { startAfter: expiresAt });
    await tx.processingLockRecord.update({ where: { id: lock.id }, data: { pgBossJobId: actualJobId } });

    const delta = await tx.revalidationDeltaRecord.create({
      data: {
        processingLockId: lock.id,
        availabilityChanged: false,
        deficientStatusChanged: false,
        pricingChanged: false,
        availabilityDelta: undefined,
        deficientDelta: undefined,
        pricingDelta: undefined,
        createdBy: actorId,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "PROCESSING_LOCK.RECONFIRMED",
        actorId,
        actorLevel: "L1",
        entityType: "ProcessingLockRecord",
        entityId: lock.id,
        operation: "CREATE",
        timestamp: placedAt,
        entryId: lock.entryId,
        payload: { previousLockId: old.id, newLockId: lock.id },
        createdBy: actorId,
      },
    });

    return { lock, delta };
  });

  return { newLock: out.lock, previousLockId: old.id, revalidationDelta: out.delta };
}

export async function status(prisma: PrismaClient, id: string) {
  if (!id?.trim()) throw new ValidationError("id is required");
  const lock = await prisma.processingLockRecord.findUnique({ where: { id } });
  if (!lock) throw new NotFoundError("ProcessingLockRecord");
  return lock;
}

