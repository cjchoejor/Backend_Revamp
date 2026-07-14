import type { PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Prisma, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";

/**
 * Enumerate every room a `CommittedHold` is holding. Reads the (Phase-D) `perNightBreakdown`
 * JSON snapshot when present; falls back to the legacy single `roomId` field. Result is a
 * distinct set so a per-night mid-stay room change (room 201 → room 301) yields both ids.
 *
 * Used by every hold-lifecycle transition below (confirm, release-for-room-change, release-
 * on-re-entry) so multi-room bookings' full inventory follows the state changes, not just
 * the "primary" room in `hold.roomId`.
 */
function allHeldRoomIds(hold: { roomId: string | null; perNightBreakdown: unknown }): string[] {
  const set = new Set<string>();
  if (hold.roomId) set.add(hold.roomId);
  const breakdown = hold.perNightBreakdown as
    | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
    | null
    | undefined;
  if (Array.isArray(breakdown)) {
    for (const night of breakdown) {
      for (const r of night.roomIds ?? []) {
        if (typeof r?.roomId === "string") set.add(r.roomId);
      }
    }
  }
  return Array.from(set);
}
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
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
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      folio: true,
      cancellationDisclosure: true,
      // Load the sealed availability configuration so its per-night breakdown (when
      // present) can be snapshotted onto the committed hold — no more losing the
      // "different room per night" fact at the S1 → S3 boundary.
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Extract perNight breakdown from the sealed AvailabilityConfiguration, if it's a
  // per-night seal. Legacy single-room and whole-stay seals return null (no breakdown to
  // preserve). Store on the hold so downstream services can reconstruct the intent.
  const sealedConfig = entry.availabilityConfigs[0];
  const opt = (sealedConfig?.optionSelected ?? null) as
    | { perNight?: Array<{ date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> }> }
    | null;
  const perNightBreakdown = opt && Array.isArray(opt.perNight) ? opt.perNight : null;

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

  // Policy registry override: `registry.holdExpiry.minutes` (when enabled) replaces the
  // legacy `expiry.s3.committedHoldTtlSeconds` ConfigurationEntry. Set `enabled: false` to
  // revert to the ConfigurationEntry value.
  const holdPolicy = await getRegistryPolicy(prisma, "registry.holdExpiry.minutes");
  const registryTtlSeconds =
    holdPolicy && holdPolicy.enabled !== false && typeof holdPolicy.minutes === "number"
      ? (holdPolicy.minutes as number) * 60
      : null;
  const ttlSeconds =
    registryTtlSeconds ??
    (await requireActiveConfigValue<number>(prisma, "expiry.s3.committedHoldTtlSeconds").catch(() => {
      throw new MissingConfigurationError("expiry.s3.committedHoldTtlSeconds");
    }));

  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!room) throw new NotFoundError("Room");
  enforceCommittedHoldInventoryAvailable({ currentClaimState: room.currentClaimState });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(ttlSeconds) * 1000);

  // Multi-room support: the sealed AvailabilityConfiguration is the source of truth for
  // "which rooms this booking is holding". Beyond input.roomId (the primary room the hold
  // service originally pinned), we collect any OTHER distinct rooms from the sealed config
  // and pin them all to COMMITTED_HELD. Prevents double-booking of rooms 2..N in a
  // multi-room booking (the historical bug).
  const sealedForHold = readOptionSelected(sealedConfig?.optionSelected);
  const allSealedRoomIds = Array.from(new Set([input.roomId, ...sealedForHold.distinctRoomIds]));
  const additionalRooms = allSealedRoomIds.filter((id) => id !== input.roomId);
  // Load the additional rooms' current states so we can guard them the same way.
  const additionalRoomRows =
    additionalRooms.length > 0
      ? await prisma.room.findMany({
          where: { id: { in: additionalRooms } },
        })
      : [];
  for (const r of additionalRoomRows) {
    enforceCommittedHoldInventoryAvailable({ currentClaimState: r.currentClaimState });
  }

  return prisma.$transaction(async (tx) => {
    // Upgrade speculative hold if present on this segment/room.
    const spec = await tx.speculativeHold.findFirst({
      where: { entryId, segmentId, roomId: input.roomId, state: HoldState.PLACED },
      orderBy: { placedAt: "desc" },
    });

    // Pin every sealed room to COMMITTED_HELD in one pass. Room already in COMMITTED_HELD
    // (previous partial retry) is left alone.
    const roomsToPin: Array<{ id: string; currentClaimState: InventoryClaimState }> = [
      { id: input.roomId, currentClaimState: room.currentClaimState },
      ...additionalRoomRows.map((r) => ({ id: r.id, currentClaimState: r.currentClaimState })),
    ];
    for (const r of roomsToPin) {
      if (r.currentClaimState === InventoryClaimState.COMMITTED_HELD) continue;
      await tx.room.update({ where: { id: r.id }, data: { currentClaimState: InventoryClaimState.COMMITTED_HELD } });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: r.id,
          entryId,
          fromState: r.currentClaimState,
          toState: InventoryClaimState.COMMITTED_HELD,
          actorId: actor.actorId,
          reason: spec && r.id === input.roomId ? "COMMITTED_HOLD_UPGRADE_FROM_SPECULATIVE" : "COMMITTED_HOLD_PLACED",
          effectiveFrom: now,
        },
      });
    }

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
        ...(perNightBreakdown ? { perNightBreakdown: perNightBreakdown as Prisma.InputJsonValue } : {}),
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
        ...(perNightBreakdown ? { perNightBreakdown: perNightBreakdown as Prisma.InputJsonValue } : {}),
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

/**
 * SIG-S4 / HoldService — `confirmCommittedHold`: PLACED→CONFIRMED, inventory COMMITTED_HELD→CONFIRMED, cancel **W3** expiry in the same transaction.
 */
export async function confirmCommittedHoldTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; holdId: string; actorId: string; inquiryId: string | null },
) {
  const hold = await tx.committedHold.findUnique({ where: { id: input.holdId } });
  if (!hold || hold.entryId !== input.entryId) throw new NotFoundError("CommittedHold");
  if (hold.state !== HoldState.PLACED) {
    throw new ValidationError("CommittedHold must be PLACED to confirm");
  }
  // Multi-room-safe: legacy single-room holds satisfy this via hold.roomId; per-night
  // multi-room holds satisfy it via the perNightBreakdown snapshot. Either provides the
  // rooms to transition below.
  const heldRoomIds = allHeldRoomIds(hold);
  if (heldRoomIds.length === 0) throw new ValidationError("CommittedHold has no rooms recorded");

  const now = new Date();

  await tx.committedHold.update({
    where: { id: hold.id },
    data: { state: HoldState.CONFIRMED, confirmedAt: now, confirmedBy: input.actorId },
  });
  // Confirm every held room in one pass — COMMITTED_HELD → CONFIRMED. Skip rooms already
  // CONFIRMED (idempotent for retries).
  for (const roomId of heldRoomIds) {
    const roomRow = await tx.room.findUnique({ where: { id: roomId } });
    if (!roomRow) throw new NotFoundError("Room");
    if (roomRow.currentClaimState === InventoryClaimState.CONFIRMED) continue;
    await tx.room.update({
      where: { id: roomId },
      data: { currentClaimState: InventoryClaimState.CONFIRMED },
    });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId,
        entryId: input.entryId,
        fromState: InventoryClaimState.COMMITTED_HELD,
        toState: InventoryClaimState.CONFIRMED,
        actorId: input.actorId,
        reason: "S4_CONFIRMATION",
        effectiveFrom: now,
      },
    });
  }

  const engine = await getTimerEngine();
  const timers = await tx.timerRecord.findMany({
    where: { entryId: input.entryId, timerCode: "COMMITTED_HOLD_EXPIRY_W3", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: input.actorId, cancelledReason: "S4_CONFIRMATION" } as any,
  });

  await tx.traceEvent.create({
    data: {
      eventType: "COMMITTED_HOLD.CONFIRMED",
      actorId: input.actorId,
      actorLevel: "L1",
      entityType: "CommittedHold",
      entityId: hold.id,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S4,
      inquiryId: input.inquiryId,
      entryId: input.entryId,
      payload: { entryId: input.entryId, committedHoldId: hold.id },
      createdBy: input.actorId,
    },
  });

  return tx.committedHold.findUniqueOrThrow({ where: { id: hold.id } });
}

/**
 * SIG-S6 room change — release the entry's committed hold regardless of state (PLACED or
 * CONFIRMED) so the old room is freed and a fresh hold can be placed for the newly chosen room.
 * Frees the held room, cancels W3 expiry timers, and writes a trace event. Idempotent: a hold
 * already RELEASED/EXPIRED is left untouched. Runs inside the caller's transaction.
 */
export async function releaseCommittedHoldForRoomChange(
  tx: Prisma.TransactionClient,
  entryId: string,
  actor: { actorId: string; actorLevel: string },
  reason: string,
  inquiryId: string | null,
) {
  const hold = await tx.committedHold.findUnique({ where: { entryId } });
  if (!hold) return null;
  if (hold.state === HoldState.RELEASED || hold.state === HoldState.EXPIRED) return hold;
  const now = new Date();

  // Multi-room: release EVERY held room via the helper (reads perNightBreakdown + roomId).
  for (const roomId of allHeldRoomIds(hold)) {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (room && room.currentClaimState !== InventoryClaimState.FREE) {
      await tx.room.update({ where: { id: roomId }, data: { currentClaimState: InventoryClaimState.FREE, updatedAt: now } });
      await tx.roomClaimStateEvent.create({
        data: { roomId, entryId, fromState: room.currentClaimState, toState: InventoryClaimState.FREE, actorId: actor.actorId, reason, effectiveFrom: now },
      });
    }
  }

  const engine = await getTimerEngine();
  const timers = await tx.timerRecord.findMany({
    where: { entityType: "CommittedHold", entityId: hold.id, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: reason } as any,
  });

  const updated = await tx.committedHold.update({
    where: { id: hold.id },
    data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: actor.actorId, releaseReason: reason },
  });

  await tx.traceEvent.create({
    data: {
      eventType: "COMMITTED_HOLD.RELEASED_ON_ROOM_CHANGE",
      actorId: actor.actorId,
      actorLevel: (actor.actorLevel ?? "L1") as any,
      entityType: "CommittedHold",
      entityId: hold.id,
      operation: "RELEASE",
      timestamp: now,
      stageContext: Stage.S6,
      inquiryId,
      entryId,
      payload: { entryId, committedHoldId: hold.id, roomId: hold.roomId, priorState: hold.state, reason },
      createdBy: actor.actorId,
    },
  });

  return updated;
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

  // Multi-room: release every room this hold was covering.
  for (const roomId of allHeldRoomIds(hold)) {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room) continue;
    if (room.currentClaimState === InventoryClaimState.FREE) continue;
    await tx.room.update({ where: { id: roomId }, data: { currentClaimState: InventoryClaimState.FREE } });
    await tx.roomClaimStateEvent.create({
      data: { roomId, entryId, fromState: room.currentClaimState, toState: InventoryClaimState.FREE, actorId: actor.actorId, reason: "REENTRY_S3_TO_S1_HOLD_RELEASED", effectiveFrom: now },
    });
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

