import type { PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Prisma, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { randomUUID } from "node:crypto";
import {
  enforceNoOverlappingBookingForSpeculativeHold,
  enforceSpeculativeHoldAuthority,
  enforceSpeculativeHoldInventoryEligible,
  enforceSpeculativeHoldReleaseAuthority,
} from "../../policies/10-speculative-hold/p25-speculative-hold-placement.js";
import { enforceCommittedHoldRoomPhysicallyUsable } from "../../policies/11-committed-hold/p26-committed-hold-inventory-availability.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { foldIsoNightsToRanges, heldRoomIds } from "../../lib/entry-inventory-claim.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { enforceEntryAtS2ForSpeculativeHoldPlacement } from "../../policies/10-speculative-hold/p25-s2-stage-for-speculative-hold-placement.js";
import { enforceSpeculativeHoldPlacedForRelease } from "../../policies/10-speculative-hold/p25-speculative-hold-placed-for-release.js";

type PlacementThresholds = {
  thresholds: Array<{ maxRooms: number | null; authorityRequired: "FRONT_DESK" | "FOM" | "GM"; maxConcurrentHolds: number | null }>;
};

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
  enforceEntryAtS2ForSpeculativeHoldPlacement({ currentStage: entry.currentStage });

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  if (!!input.roomId === !!input.spaceId) throw new ValidationError("Exactly one of roomId or spaceId is required");
  if (!input.commercialBasis?.trim()) throw new ValidationError("commercialBasis is required");

  /**
   * The hold covers the WHOLE sealed selection, not one room (2026-08-06, operator report: a
   * hold on the anchor room left the seal's other rooms showing vacant to every other search).
   * When the entry has a sealed per-night selection that includes the requested room, every
   * sealed room is held — each over its own claimed nights, snapshotted into
   * `perNightBreakdown` exactly like the S3 committed hold. A room outside the seal (or no
   * seal at all) keeps the legacy single-room behaviour.
   */
  const sealedCfg = input.roomId
    ? await prisma.availabilityConfiguration.findFirst({
        where: { entryId, sealedAt: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { optionSelected: true },
      })
    : null;
  const sealed = readOptionSelected(sealedCfg?.optionSelected);
  const sealCoversInput = !!input.roomId && sealed.distinctRoomIds.includes(input.roomId);
  const coveredRoomIds: string[] = input.roomId
    ? sealCoversInput
      ? [input.roomId, ...sealed.distinctRoomIds.filter((id) => id !== input.roomId)]
      : [input.roomId]
    : [];
  /** The snapshot to store — the seal's per-night list in CommittedHold's shape, when covering it. */
  const perNightBreakdown =
    sealCoversInput && sealed.perNight && sealed.perNight.length > 0
      ? sealed.perNight.map((n) => ({ date: n.date, roomIds: n.roomIds.map((roomId) => ({ roomId })) }))
      : null;

  const placementThresholds = await requireActiveConfigValue<PlacementThresholds>(prisma, "speculativeHold.placementThresholds").catch(() => {
    throw new MissingConfigurationError("speculativeHold.placementThresholds");
  });

  // Policy registry override: `registry.s2HoldExpiry.minutes` (when enabled) replaces the
  // legacy `expiry.s2.speculativeHoldTtlSeconds` ConfigurationEntry.
  const s2HoldPolicy = await getRegistryPolicy(prisma, "registry.s2HoldExpiry.minutes");
  const registryS2HoldSeconds =
    s2HoldPolicy && s2HoldPolicy.enabled !== false && typeof s2HoldPolicy.minutes === "number"
      ? (s2HoldPolicy.minutes as number) * 60
      : null;
  const defaultTtl =
    registryS2HoldSeconds ??
    (await requireActiveConfigValue<number>(prisma, "expiry.s2.speculativeHoldTtlSeconds").catch(() => {
      throw new MissingConfigurationError("expiry.s2.speculativeHoldTtlSeconds");
    }));

  const ttlSeconds = Number.isFinite(input.ttlSeconds) && Number(input.ttlSeconds) > 0 ? Number(input.ttlSeconds) : Number(defaultTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new ValidationError("ttlSeconds must be positive");

  // Authority is measured by how many rooms the hold actually covers (2026-08-06 — was a
  // hardcoded 1 from the single-room slice): the seeded thresholds put ≤5 rooms at FRONT_DESK,
  // ≤15 at FOM, above at GM.
  const roomsRequested = Math.max(1, coveredRoomIds.length);
  const threshold =
    placementThresholds.thresholds.find((t) => t.maxRooms == null || roomsRequested <= t.maxRooms) ??
    { maxRooms: null, authorityRequired: "GM" as const, maxConcurrentHolds: null };

  enforceSpeculativeHoldAuthority({ authorityRequired: threshold.authorityRequired, actorLevel: actor.actorLevel });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // ---- Availability validation (2026-08-06: date-aware, mirrors placeCommittedHold) --------
  // `currentClaimState` is a NOW snapshot with no date dimension — it goes COMMITTED_HELD at S3
  // and stays until departure, so the old FREE-only gate refused a speculative hold on any room
  // whose only claim was for entirely different dates (the same fault Policy 26 had). Commercial
  // availability now comes from date overlap against other bookings; physical availability from
  // blocked/maintenance. The claim-state gate survives only on the degenerate no-dates path,
  // where there is nothing to intersect.
  if (coveredRoomIds.length > 0) {
    const rooms = await prisma.room.findMany({ where: { id: { in: coveredRoomIds } } });
    if (rooms.length !== coveredRoomIds.length) throw new NotFoundError("Room");
    if (entry.checkInDate && entry.checkOutDate) {
      /**
       * Every covered room is checked over the nights the SEAL claims it for — not the whole
       * stay (2026-08-06, second pass). A per-night seal can use room 206 on the first night
       * only, precisely because someone else holds it from the second; checking the full range
       * found that other hold and refused a hold S1's own search legitimately offered. Rooms
       * without a per-night entry (whole-stay seals, legacy) keep the full stay.
       */
      for (const room of rooms) {
        const claimedNights = (sealed.perNight ?? [])
          .filter((n) => n.roomIds.includes(room.id))
          .map((n) => String(n.date).slice(0, 10));
        const ranges =
          claimedNights.length > 0
            ? foldIsoNightsToRanges(claimedNights)
            : [{ startDate: entry.checkInDate, endDate: entry.checkOutDate }];
        for (const r of ranges) {
          enforceCommittedHoldRoomPhysicallyUsable({
            roomNumber: room.roomNumber,
            isBlocked: room.isBlocked,
            blockedReason: room.blockedReason,
            isUnderMaintenance: room.isUnderMaintenance,
            maintenanceDeadline: room.maintenanceDeadline,
            checkIn: r.startDate,
            checkOut: r.endDate,
          });
          const conflicts = await findRoomBookingConflicts(prisma, {
            roomIds: [room.id],
            checkIn: r.startDate,
            checkOut: r.endDate,
            excludeEntryId: entryId,
          });
          enforceNoOverlappingBookingForSpeculativeHold({
            conflicts: conflicts.map((c) => ({ ...c, roomNumber: room.roomNumber })),
          });
        }
      }
    } else {
      for (const room of rooms) {
        enforceSpeculativeHoldInventoryEligible({ currentClaimState: room.currentClaimState });
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    for (const roomId of coveredRoomIds) {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room) throw new NotFoundError("Room");
      // The display flag is only pinned when this hold actually owns it: a room whose flag is
      // COMMITTED_HELD/CONFIRMED belongs to another booking's (other-dates) claim, and
      // overwriting it would downgrade what the rooms board shows. The hold row itself — not
      // the flag — is what the availability engine and the conflict finder read.
      if (room.currentClaimState === InventoryClaimState.FREE) {
        await tx.room.update({ where: { id: roomId }, data: { currentClaimState: InventoryClaimState.SPECULATIVELY_HELD } });
        await tx.roomClaimStateEvent.create({
          data: {
            roomId,
            entryId,
            fromState: InventoryClaimState.FREE,
            toState: InventoryClaimState.SPECULATIVELY_HELD,
            actorId: actor.actorId,
            reason: "SPECULATIVE_HOLD_PLACED",
            effectiveFrom: now,
          },
        });
      }
    }

    const hold = await tx.speculativeHold.create({
      data: {
        entryId,
        segmentId,
        roomId: input.roomId ?? null,
        spaceId: input.spaceId ?? null,
        // The whole sealed selection, per night — what the availability engine and the S3 gate
        // read as this hold's coverage (they fall back to `roomId` × entry stay when null).
        ...(perNightBreakdown ? { perNightBreakdown: perNightBreakdown as Prisma.InputJsonValue } : {}),
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
        payload: {
          holdId: hold.id,
          roomId: hold.roomId,
          roomIds: coveredRoomIds,
          spaceId: hold.spaceId,
          ttlSeconds,
          expiresAt: expiresAt.toISOString(),
          commercialBasis: input.commercialBasis,
        },
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
  enforceSpeculativeHoldReleaseAuthority({ actorLevel: actor.actorLevel });
  if (!input.releaseReason?.trim()) throw new ValidationError("releaseReason is required");

  const hold = await prisma.speculativeHold.findUnique({ where: { id: holdId } });
  if (!hold || hold.entryId !== entryId) throw new NotFoundError("SpeculativeHold");
  enforceSpeculativeHoldPlacedForRelease({ state: hold.state });

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Every room this hold covers — the per-night snapshot's rooms plus the primary (2026-08-06;
    // release used to free only `roomId`, leaving the seal's other rooms pinned).
    for (const roomId of heldRoomIds(hold)) {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      // Free the display flag only when this hold owns it (it reads SPECULATIVELY_HELD — a
      // stronger claim's flag must not be reset by an S2 release) and no OTHER live speculative
      // hold covers the room, which date-aware placement now allows.
      if (room && room.currentClaimState === InventoryClaimState.SPECULATIVELY_HELD) {
        const otherLive = await tx.speculativeHold.findMany({
          where: { state: HoldState.PLACED, id: { not: holdId }, expiresAt: { gt: now } },
          select: { roomId: true, perNightBreakdown: true },
        });
        const stillCovered = otherLive.some((h) => heldRoomIds(h).includes(roomId));
        if (!stillCovered) {
          await tx.room.update({ where: { id: roomId }, data: { currentClaimState: InventoryClaimState.FREE } });
          await tx.roomClaimStateEvent.create({
            data: {
              roomId,
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

