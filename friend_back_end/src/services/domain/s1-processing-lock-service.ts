import type { PrismaClient } from "@prisma/client";
import { ProcessingLockStatus } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceAvailabilityQueryParamsForS1 } from "../../policies/01-availability/p01-availability-query-params-s1.js";
import { queryAvailability as availabilityEngineQuery } from "../../engines/availability-engine.js";
import { resolveIndicativePricingForS1Availability } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s1-indicative.js";
import { resolveProcessingLockTtlSeconds } from "../../policies/31-processing-lock/p71-processing-lock-ttl.js";
import { formatProcessingLockPriorityNotice } from "../../policies/31-processing-lock/p72-processing-lock-priority-queue.js";
import { enforceProcessingLockExpiredForReconfirm } from "../../policies/31-processing-lock/p71-processing-lock-expired-for-reconfirm.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as auditService from "../infrastructure/audit-service.js";
import * as notificationService from "../infrastructure/notification-service.js";

function readSearchCriteria(scRaw: unknown) {
  const sc = (scRaw ?? {}) as Record<string, unknown>;
  return {
    roomTypeId: typeof sc.roomTypeId === "string" ? sc.roomTypeId : undefined,
    checkInDate: typeof sc.checkInDate === "string" ? sc.checkInDate : "",
    checkOutDate: typeof sc.checkOutDate === "string" ? sc.checkOutDate : "",
    guestCount: typeof sc.guestCount === "number" ? sc.guestCount : sc.guestCount != null ? Number(sc.guestCount) : undefined,
    useType: typeof sc.useType === "string" ? sc.useType : undefined,
  };
}

function extractSelectedRoomId(cfg: { optionSelected: any }): string | null {
  const os = cfg.optionSelected as any;
  const roomId = os && typeof os === "object" ? (os.roomId as unknown) : null;
  return typeof roomId === "string" && roomId.trim() ? roomId.trim() : null;
}

function extractSelectedWasDeficient(cfg: { optionSelected: any }): boolean | null {
  const os = cfg.optionSelected as any;
  const v = os && typeof os === "object" ? (os.isDeficient as unknown) : null;
  return typeof v === "boolean" ? v : null;
}

function stableJson(x: unknown): string {
  try {
    return JSON.stringify(x ?? null);
  } catch {
    return String(x);
  }
}

export async function placeLock(
  prisma: PrismaClient,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { inventoryReference: string; channel: "EMAIL_AI" | "WHATSAPP_AI" | "FRONT_DESK" | "PHONE"; entryContext?: { entryId: string; segmentId?: string } },
) {
  if (!input.inventoryReference?.trim()) throw new ValidationError("inventoryReference is required");
  if (!input.channel?.trim()) throw new ValidationError("channel is required");

  const ttlMap = await requireActiveConfigValue<Record<string, number>>(prisma, "processingLock.ttl.perChannel");
  const ttlSeconds = resolveProcessingLockTtlSeconds({ ttlMap, channel: input.channel });

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
    const updated = await tx.processingLockRecord.update({ where: { id: lock.id }, data: { pgBossJobId: actualJobId } });

    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
      eventType: "PROCESSING_LOCK.PLACED",
      entityType: "ProcessingLockRecord",
      entityId: lock.id,
      operation: "CREATE",
      timestamp: placedAt,
      stageContext: null,
      inquiryId: null,
      entryId: lock.entryId,
      payload: { lockId: lock.id, inventoryReference: lock.inventoryReference, channel: lock.channel, expiresAt: lock.expiresAt.toISOString() },
      createdBy: actor.actorId,
    });

    return updated;
  });

  return {
    lock: created,
    meta: formatProcessingLockPriorityNotice({ priorActiveLockId: prior?.id }),
  };
}

export async function reconfirm(prisma: PrismaClient, actorId: string, expiredLockId: string) {
  if (!expiredLockId?.trim()) throw new ValidationError("id is required");
  const old = await prisma.processingLockRecord.findUnique({ where: { id: expiredLockId } });
  if (!old) throw new NotFoundError("ProcessingLockRecord");
  enforceProcessingLockExpiredForReconfirm({ status: old.status });

  const ttlMap = await requireActiveConfigValue<Record<string, number>>(prisma, "processingLock.ttl.perChannel");
  const ttlSeconds = resolveProcessingLockTtlSeconds({ ttlMap, channel: old.channel });

  const placedAt = new Date();
  const expiresAt = new Date(placedAt.getTime() + ttlSeconds * 1000);

  const entryId = old.entryId ?? null;
  const latestCfg =
    entryId != null
      ? await prisma.availabilityConfiguration.findFirst({
          where: { entryId },
          orderBy: { createdAt: "desc" },
        })
      : null;

  const prevSelectedRoomId = latestCfg ? extractSelectedRoomId(latestCfg as any) : null;
  const prevWasDeficient = latestCfg ? extractSelectedWasDeficient(latestCfg as any) : null;
  const prevIndicative =
    latestCfg && (latestCfg as any).resultSet && typeof (latestCfg as any).resultSet === "object" ? (latestCfg as any).resultSet.indicativePricing ?? null : null;

  let availabilityChanged = false;
  let deficientStatusChanged = false;
  let pricingChanged = false;
  let availabilityDelta: any = null;
  let deficientDelta: any = null;
  let pricingDelta: any = null;

  if (entryId && latestCfg && prevSelectedRoomId) {
    const entry = await prisma.entry.findUnique({ where: { id: entryId } });
    if (entry) {
      const sc = readSearchCriteria((latestCfg as any).searchCriteria);
      if (sc.checkInDate && sc.checkOutDate) {
        const { checkIn, checkOut, guestCount } = enforceAvailabilityQueryParamsForS1({
          checkInDate: sc.checkInDate,
          checkOutDate: sc.checkOutDate,
          guestCount: sc.guestCount ?? (entry as any).guestCount,
        });

        const shadowRules = await requireActiveConfigValue<any[]>(prisma, "availability.shadowInventory.visibilityRules");
        const bookablePhysicalStates = await requireActiveConfigValue<any>(prisma, "availability.bookablePhysicalStates").catch(() => ["FREE"]);
        const rooms = await prisma.room.findMany({ orderBy: { roomNumber: "asc" } });

        const engineOut: any = availabilityEngineQuery({
          checkInDate: checkIn,
          checkOutDate: checkOut,
          roomTypeId: sc.roomTypeId,
          guestCount,
          useType: (sc.useType as any) ?? (entry as any).useType,
          otaSource: (entry as any).otaSource,
          guestTier: "STANDARD",
          actorLevel: "L1",
          shadowInventoryRules: shadowRules ?? [],
          bookablePhysicalStates,
          rooms: rooms.map((r) => ({
            id: r.id,
            roomNumber: r.roomNumber,
            roomTypeId: r.roomTypeId,
            capacity: r.capacity,
            currentClaimState: r.currentClaimState,
            isShadowInventory: (r as any).isShadowInventory === true,
            isDeficient: r.isDeficient,
            deficientConditionCategory: r.deficientConditionCategory,
            isUnderMaintenance: r.isUnderMaintenance,
            maintenanceDeadline: r.maintenanceDeadline,
            isBlocked: r.isBlocked,
            blockedReason: r.blockedReason,
          })),
          spaces: [],
          currentTimestamp: new Date(),
        });

        const indicative = await resolveIndicativePricingForS1Availability(prisma, { checkIn, checkOut });
        const currentIndicative = indicative ?? null;

        const buckets = {
          available: (engineOut.availableRooms ?? []) as any[],
          deficient: (engineOut.deficientRooms ?? []) as any[],
          unavailable: (engineOut.unavailableRooms ?? []) as any[],
        };
        const idMatch = (r: any) => r?.inventoryId === prevSelectedRoomId || r?.roomId === prevSelectedRoomId;
        const inAvailable = buckets.available.find(idMatch);
        const inDeficient = buckets.deficient.find(idMatch);
        const inUnavailable = buckets.unavailable.find(idMatch);

        const nowSelectable = !!(inAvailable || inDeficient) && !inUnavailable;
        const nowDeficient = !!inDeficient;

        availabilityChanged = !nowSelectable;
        deficientStatusChanged = prevWasDeficient != null ? prevWasDeficient !== nowDeficient : nowDeficient;
        pricingChanged = stableJson(prevIndicative) !== stableJson(currentIndicative);

        availabilityDelta = {
          selectedRoomId: prevSelectedRoomId,
          nowSelectable,
          bucket: inAvailable ? "AVAILABLE" : inDeficient ? "DEFICIENT" : inUnavailable ? "UNAVAILABLE" : "MISSING",
          unavailabilityReason: inUnavailable?.unavailabilityReason ?? null,
        };
        deficientDelta = { selectedRoomId: prevSelectedRoomId, wasDeficient: prevWasDeficient, isDeficient: nowDeficient };
        pricingDelta = { previousIndicative: prevIndicative, currentIndicative };
      }
    }
  }

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
        availabilityChanged,
        deficientStatusChanged,
        pricingChanged,
        availabilityDelta: availabilityDelta ?? undefined,
        deficientDelta: deficientDelta ?? undefined,
        pricingDelta: pricingDelta ?? undefined,
        createdBy: actorId,
      },
    });

    await auditService.emit(tx as any, { actorId, actorLevel: "L1" }, {
      eventType: "PROCESSING_LOCK.RECONFIRMED",
      entityType: "ProcessingLockRecord",
      entityId: lock.id,
      operation: "CREATE",
      timestamp: placedAt,
      entryId: lock.entryId,
      payload: { previousLockId: old.id, newLockId: lock.id },
      createdBy: actorId,
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

export async function expireLock(prisma: PrismaClient, lockId: string) {
  if (!lockId?.trim()) throw new ValidationError("id is required");
  const lock = await prisma.processingLockRecord.findUnique({ where: { id: lockId } });
  if (!lock) throw new NotFoundError("ProcessingLockRecord");

  if (lock.status === ProcessingLockStatus.EXPIRED || lock.status === ProcessingLockStatus.RELEASED) {
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }

  const expiredAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.processingLockRecord.update({
      where: { id: lock.id },
      data: { status: ProcessingLockStatus.EXPIRED, expiredAt },
    });
    await auditService.emit(tx as any, auditService.systemActor(), {
      eventType: "PROCESSING_LOCK.EXPIRED",
      entityType: "ProcessingLockRecord",
      entityId: lock.id,
      operation: "TRANSITION",
      timestamp: expiredAt,
      payload: {
        lockId: lock.id,
        actorId: lock.actorId,
        inventoryReference: lock.inventoryReference,
        channel: lock.channel,
        expiredAt: expiredAt.toISOString(),
      },
      entryId: lock.entryId ?? null,
      createdBy: "SYSTEM",
    });
  });

  await notificationService.dispatchOperatorExpiry(prisma, {
    entityType: "ProcessingLockRecord",
    entityId: lock.id,
    entryId: lock.entryId ?? null,
    inventoryReference: lock.inventoryReference,
    reason: "PROCESSING_LOCK_TTL_EXPIRED",
  });

  return { skipped: false } as const;
}

