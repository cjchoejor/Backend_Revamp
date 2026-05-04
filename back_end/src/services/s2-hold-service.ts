import type { PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";
import { randomUUID } from "node:crypto";

type PlacementThresholds = {
  thresholds: Array<{ maxRooms: number | null; authorityRequired: "FRONT_DESK" | "FOM" | "GM"; maxConcurrentHolds: number | null }>;
};

function requiresAuthority(required: "FRONT_DESK" | "FOM" | "GM", actorLevel: "L1" | "L2" | "L3" | "L4") {
  if (required === "FRONT_DESK") return false;
  if (required === "FOM") return actorLevel === "L1";
  if (required === "GM") return actorLevel === "L1" || actorLevel === "L2";
  return true;
}

export async function placeSpeculativeHold(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { roomId?: string; spaceId?: string; ttlSeconds?: number; commercialBasis?: string; notes?: string },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S2) throw new StageGateBlockedError("Entry must be at S2 to place speculative hold", "NOT_AT_S2");

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  if (!!input.roomId === !!input.spaceId) throw new ValidationError("Exactly one of roomId or spaceId is required");
  if (!input.commercialBasis?.trim()) throw new ValidationError("commercialBasis is required");

  const placementThresholds = await requireActiveConfigValue<PlacementThresholds>(prisma, "speculativeHold.placementThresholds").catch(() => {
    throw new MissingConfigurationError("speculativeHold.placementThresholds");
  });

  const defaultTtl = await requireActiveConfigValue<number>(prisma, "expiry.s2.speculativeHoldTtlSeconds").catch(() => {
    throw new MissingConfigurationError("expiry.s2.speculativeHoldTtlSeconds");
  });

  const ttlSeconds = Number.isFinite(input.ttlSeconds) && Number(input.ttlSeconds) > 0 ? Number(input.ttlSeconds) : Number(defaultTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new ValidationError("ttlSeconds must be positive");

  // Current slice only places single-room holds; use thresholds with maxRooms=1 for authority evaluation.
  const roomsRequested = 1;
  const threshold =
    placementThresholds.thresholds.find((t) => t.maxRooms == null || roomsRequested <= t.maxRooms) ??
    { maxRooms: null, authorityRequired: "GM" as const, maxConcurrentHolds: null };

  if (requiresAuthority(threshold.authorityRequired, actor.actorLevel)) {
    throw new PolicyGateBlockedError("SPECULATIVE_HOLD_REQUIRES_ESCALATION", `Speculative hold requires ${threshold.authorityRequired} authority`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  return prisma.$transaction(async (tx) => {
    if (input.roomId) {
      const room = await tx.room.findUnique({ where: { id: input.roomId } });
      if (!room) throw new NotFoundError("Room");
      if (room.currentClaimState !== InventoryClaimState.FREE) {
        throw new PolicyGateBlockedError("ROOM_NOT_FREE", "Room is not available for speculative hold");
      }
      await tx.room.update({ where: { id: input.roomId }, data: { currentClaimState: InventoryClaimState.SPECULATIVELY_HELD } });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: input.roomId,
          entryId,
          fromState: InventoryClaimState.FREE,
          toState: InventoryClaimState.SPECULATIVELY_HELD,
          actorId: actor.actorId,
          reason: "SPECULATIVE_HOLD_PLACED",
          effectiveFrom: now,
        },
      });
    }

    const hold = await tx.speculativeHold.create({
      data: {
        entryId,
        segmentId,
        roomId: input.roomId ?? null,
        spaceId: input.spaceId ?? null,
        state: HoldState.PLACED,
        placedAt: now,
        placedBy: actor.actorId,
        ttlSeconds,
        expiresAt,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      },
    });

    const timerRecordId = randomUUID();
    const engine = await getTimerEngine();
    const jobId = await engine.schedule("SPECULATIVE_HOLD_EXPIRY_W2", { holdId: hold.id, timerRecordId }, { startAfter: expiresAt });
    await tx.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId,
        entityType: "SpeculativeHold",
        entityId: hold.id,
        timerType: "SPECULATIVE_HOLD_EXPIRY_W2",
        timerCode: "SPECULATIVE_HOLD_EXPIRY_W2",
        stageContext: Stage.S2,
        firesAt: expiresAt,
        dueAt: expiresAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        payload: { holdId: hold.id, timerRecordId },
        createdBy: actor.actorId,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "SPECULATIVE_HOLD.PLACED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "SpeculativeHold",
        entityId: hold.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { holdId: hold.id, roomId: hold.roomId, spaceId: hold.spaceId, ttlSeconds, expiresAt: expiresAt.toISOString(), commercialBasis: input.commercialBasis },
        createdBy: actor.actorId,
      },
    });

    return hold;
  });
}

export async function releaseSpeculativeHold(
  prisma: PrismaClient,
  entryId: string,
  holdId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { releaseReason: string },
) {
  if (actor.actorLevel === "L1") throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required to release speculative hold");
  if (!input.releaseReason?.trim()) throw new ValidationError("releaseReason is required");

  const hold = await prisma.speculativeHold.findUnique({ where: { id: holdId } });
  if (!hold || hold.entryId !== entryId) throw new NotFoundError("SpeculativeHold");
  if (hold.state !== HoldState.PLACED) throw new StateTransitionError("Hold is not in PLACED state", "HOLD_NOT_PLACED");

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    if (hold.roomId) {
      const room = await tx.room.findUnique({ where: { id: hold.roomId } });
      if (room) {
        await tx.room.update({ where: { id: hold.roomId }, data: { currentClaimState: InventoryClaimState.FREE } });
        await tx.roomClaimStateEvent.create({
          data: {
            roomId: hold.roomId,
            entryId,
            fromState: InventoryClaimState.SPECULATIVELY_HELD,
            toState: InventoryClaimState.FREE,
            actorId: actor.actorId,
            reason: "SPECULATIVE_HOLD_RELEASED",
            effectiveFrom: now,
          },
        });
      }
    }

    const engine = await getTimerEngine();
    const timers = await tx.timerRecord.findMany({
      where: { entityType: "SpeculativeHold", entityId: holdId, status: "SCHEDULED" },
      select: { id: true, pgBossJobId: true },
    });
    await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "STAFF_RELEASE" },
    });

    const updated = await tx.speculativeHold.update({
      where: { id: holdId },
      data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: actor.actorId, releaseReason: input.releaseReason.trim() },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "SPECULATIVE_HOLD.RELEASED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "SpeculativeHold",
        entityId: holdId,
        operation: "RELEASE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId,
        payload: { holdId, releaseReason: input.releaseReason.trim() },
        createdBy: actor.actorId,
      },
    });

    return updated;
  });
}

