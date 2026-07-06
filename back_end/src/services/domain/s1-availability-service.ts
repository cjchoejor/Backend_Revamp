import { Prisma } from "@prisma/client";
import type { Entry, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { queryAvailability as availabilityEngineQuery } from "../../engines/availability-engine.js";
import { enforceAvailabilityQueryParamsForS1 } from "../../policies/01-availability/p01-availability-query-params-s1.js";
import { resolveIndicativePricingForS1Availability } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s1-indicative.js";
import { annotateDeficientRoomSurface } from "../../policies/19-deficient-condition/p02-deficient-condition-surface-policy.js";
import {
  createQuotedSpaceAllocationForAvailabilityQuery,
  isConferenceLikeUseType,
} from "./space-allocation-service.js";

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

/** Shared engine run for new queries and stale-configuration recall (SIG §6.3). */
async function runAvailabilityEngineForEntry(
  prisma: PrismaClient,
  entry: Pick<Entry, "id" | "guestCount" | "useType" | "otaSource">,
  input: { roomTypeId?: string; checkInDate: string; checkOutDate: string; guestCount?: number; useType?: string },
  actorLevel: ActorLevel,
) {
  const { checkIn, checkOut, guestCount: guestCountResolved } = enforceAvailabilityQueryParamsForS1({
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    guestCount: input.guestCount ?? entry.guestCount,
  });

  const shadowRules = await requireActiveConfigValue<any[]>(prisma, "availability.shadowInventory.visibilityRules");
  const bookablePhysicalStates = await requireActiveConfigValue<any>(prisma, "availability.bookablePhysicalStates").catch(() => ["FREE"]);

  const rooms = await prisma.room.findMany({
    orderBy: { roomNumber: "asc" },
    include: { roomType: { select: { name: true } } },
  });
  const spaces = await prisma.space.findMany({ orderBy: { code: "asc" } });

  const engineRaw = availabilityEngineQuery({
    checkInDate: checkIn,
    checkOutDate: checkOut,
    roomTypeId: input.roomTypeId,
    guestCount: guestCountResolved,
    useType: (input.useType as any) ?? entry.useType,
    otaSource: entry.otaSource,
    guestTier: "STANDARD",
    actorLevel,
    shadowInventoryRules: shadowRules ?? [],
    bookablePhysicalStates,
    rooms: rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomTypeId: r.roomTypeId,
      roomTypeName: r.roomType?.name ?? null,
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
    spaces: spaces.map((s) => ({ id: s.id, spaceName: s.name, defaultCapacity: s.defaultCapacity, isAvailable: s.isAvailable, isEventInProgress: s.isEventInProgress })),
    currentTimestamp: new Date(),
  });

  const indicative = await resolveIndicativePricingForS1Availability(prisma, { checkIn, checkOut }, input.roomTypeId);
  const engineOutRaw = indicative
    ? {
        ...engineRaw,
        availableRooms: engineRaw.availableRooms.map((r) => ({ ...r, pricingIndicative: indicative })),
      }
    : engineRaw;

  const engineOut = {
    ...engineOutRaw,
    availableRooms: annotateDeficientRoomSurface(engineOutRaw.availableRooms as any),
    unavailableRooms: annotateDeficientRoomSurface(engineOutRaw.unavailableRooms as any),
    deficientRooms: annotateDeficientRoomSurface(engineOutRaw.deficientRooms as any),
  };

  const resultForApi = {
    ...engineOut,
    ...(indicative ? { indicativePricing: indicative } : {}),
    availableRooms: engineOut.availableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    unavailableRooms: engineOut.unavailableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    deficientRooms: engineOut.deficientRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
  };

  return { engineOut, resultForApi, checkIn, checkOut, guestCount: guestCountResolved };
}

async function resolveConferenceSpaceTurnaroundBufferMinutes(prisma: PrismaClient): Promise<number> {
  const row = await getActiveConfigEntry(prisma, "availability.conferenceSpace.turnaroundBufferMinutes");
  const v = row?.configValue;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

export async function queryAvailability(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    roomTypeId?: string;
    checkInDate: string;
    checkOutDate: string;
    guestCount?: number;
    useType?: string;
    spaceId?: string;
    seatingConfig?: string;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
  });
  if (!entry) throw new NotFoundError("Entry");

  const { engineOut, resultForApi, checkIn, checkOut, guestCount } = await runAvailabilityEngineForEntry(prisma, entry, input, actorLevel);
  const segmentId = entry.segments[0]?.id ?? null;
  const effectiveUse = String(input.useType ?? entry.useType);
  const spaceId = input.spaceId?.trim();
  const wantsSpaceAlloc = isConferenceLikeUseType(effectiveUse) && !!spaceId;

  if (wantsSpaceAlloc) {
    const bufferMinutes = await resolveConferenceSpaceTurnaroundBufferMinutes(prisma);
    const seatingConfig = (input.seatingConfig?.trim() || "STANDARD").trim();
    return prisma.$transaction(async (tx) => {
      const cfg = await tx.availabilityConfiguration.create({
        data: {
          entryId,
          segmentId,
          searchCriteria: { ...input },
          resultSet: engineOut as any,
          createdBy: actorId,
        },
      });
      const spaceAllocation = await createQuotedSpaceAllocationForAvailabilityQuery(tx, {
        entryId,
        segmentId,
        spaceId: spaceId!,
        windowStart: checkIn,
        windowEnd: checkOut,
        attendeeCount: guestCount,
        seatingConfig,
        actorId,
        bufferMinutes,
        currentStage: entry.currentStage,
      });
      return { configuration: cfg, result: resultForApi, spaceAllocation };
    });
  }

  const cfg = await prisma.availabilityConfiguration.create({
    data: {
      entryId,
      segmentId,
      searchCriteria: { ...input },
      resultSet: engineOut as any,
      createdBy: actorId,
    },
  });
  return { configuration: cfg, result: resultForApi };
}

export function getAvailabilityConfigurationDto(cfg: {
  id: string;
  entryId: string;
  searchCriteria: unknown;
  optionSelected: unknown;
  isStale: boolean;
  stalenessAt: Date | null;
  deficientAcknowledgements: unknown;
  sealedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: cfg.id,
    entryId: cfg.entryId,
    searchCriteria: cfg.searchCriteria,
    optionSelected: cfg.optionSelected,
    isStale: cfg.isStale,
    stalenessAt: cfg.stalenessAt?.toISOString() ?? null,
    deficientAcknowledgements: cfg.deficientAcknowledgements,
    sealedAt: cfg.sealedAt?.toISOString() ?? null,
    createdAt: cfg.createdAt.toISOString(),
  };
}

export async function getConfiguration(prisma: PrismaClient, configurationId: string) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configurationId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  return getAvailabilityConfigurationDto(cfg);
}

/**
 * Re-runs the availability engine for a **stale** configuration, persists the new result set,
 * clears prior selection, and clears the stale flag (SIG §6.3 `recallConfiguration`).
 */
export async function recallConfiguration(prisma: PrismaClient, configurationId: string, actorId: string, actorLevel: ActorLevel) {
  const cfg = await prisma.availabilityConfiguration.findUnique({
    where: { id: configurationId },
    include: { entry: { include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } } },
  });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (!cfg.isStale) {
    throw new ValidationError("configuration is not stale; recall applies only to stale configurations");
  }

  const sc = (cfg.searchCriteria ?? {}) as Record<string, unknown>;
  const input = {
    roomTypeId: sc.roomTypeId as string | undefined,
    checkInDate: String(sc.checkInDate ?? ""),
    checkOutDate: String(sc.checkOutDate ?? ""),
    guestCount: typeof sc.guestCount === "number" ? sc.guestCount : sc.guestCount != null ? Number(sc.guestCount) : undefined,
    useType: typeof sc.useType === "string" ? sc.useType : undefined,
    spaceId: typeof sc.spaceId === "string" ? sc.spaceId : undefined,
    seatingConfig: typeof sc.seatingConfig === "string" ? sc.seatingConfig : undefined,
  };
  if (!input.checkInDate?.trim() || !input.checkOutDate?.trim()) {
    throw new ValidationError("searchCriteria missing checkInDate/checkOutDate");
  }

  const { engineOut, resultForApi, checkIn, checkOut, guestCount } = await runAvailabilityEngineForEntry(prisma, cfg.entry, input, actorLevel);
  const resultSetPersisted = { ...engineOut, isRevalidationRequired: true };
  const resultForClient = { ...resultForApi, isRevalidationRequired: true };

  const bufferMinutes = await resolveConferenceSpaceTurnaroundBufferMinutes(prisma);
  const effectiveUse = String(input.useType ?? cfg.entry.useType);
  const spaceIdTrim = input.spaceId?.trim() ?? "";
  const wantsSpaceAlloc = isConferenceLikeUseType(effectiveUse) && !!spaceIdTrim;
  const seatingConfig = (input.seatingConfig?.trim() || "STANDARD").trim();
  const segmentId = cfg.entry.segments[0]?.id ?? null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.availabilityConfiguration.update({
      where: { id: configurationId },
      data: {
        resultSet: resultSetPersisted as any,
        isStale: false,
        stalenessAt: null,
        optionSelected: Prisma.DbNull,
        deficientAcknowledgements: Prisma.DbNull,
      },
    });

    let spaceAllocation;
    if (wantsSpaceAlloc) {
      spaceAllocation = await createQuotedSpaceAllocationForAvailabilityQuery(tx, {
        entryId: cfg.entryId,
        segmentId,
        spaceId: spaceIdTrim,
        windowStart: checkIn,
        windowEnd: checkOut,
        attendeeCount: guestCount,
        seatingConfig,
        actorId,
        bufferMinutes,
        currentStage: cfg.entry.currentStage,
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "AVAILABILITY_CONFIGURATION_RECALLED",
        actorId,
        actorLevel,
        entityType: "AvailabilityConfiguration",
        entityId: configurationId,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: cfg.entryId,
        payload: { configurationId, entryId: cfg.entryId },
        createdBy: actorId,
      },
    });

    return {
      configuration: updated,
      result: resultForClient,
      ...(spaceAllocation ? { spaceAllocation } : {}),
    };
  });
}

export async function selectOption(
  prisma: PrismaClient,
  configId: string,
  actorId: string,
  input: { roomId: string; deficientAcknowledgements?: unknown },
) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (cfg.isStale) throw new ValidationError("configuration is stale");
  if (!input.roomId?.trim()) throw new ValidationError("roomId is required");

  // Guard: selection must be from the persisted resultSet for this configuration.
  const rs = (cfg.resultSet ?? {}) as any;
  const selectedRoomId = input.roomId.trim();
  const inAnyBucket =
    (rs.availableRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId) ||
    (rs.deficientRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId) ||
    (rs.unavailableRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId);
  if (!inAnyBucket) {
    throw new ValidationError("roomId must be selected from the persisted AvailabilityConfiguration resultSet");
  }

  const unavailable = (rs.unavailableRooms ?? []).find((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId);
  if (unavailable) {
    throw new ValidationError(`roomId is not selectable (unavailableReason=${unavailable.unavailabilityReason ?? "UNKNOWN"})`);
  }

  const room = await prisma.room.findUnique({ where: { id: selectedRoomId }, include: { deficientConditionRecords: true } });
  if (!room) throw new NotFoundError("Room");
  const isDeficient = (room.deficientConditionRecords ?? []).some((d) => d.status !== "RESOLVED");

  if (isDeficient && !input.deficientAcknowledgements) {
    throw new ValidationError("deficientAcknowledgements is required when selecting a DEFICIENT room");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.availabilityConfiguration.update({
      where: { id: configId },
      data: {
        optionSelected: { roomId: selectedRoomId, isDeficient },
        deficientAcknowledgements: isDeficient ? (input.deficientAcknowledgements as any) : null,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "CONFIGURATION_SELECTED",
        actorId,
        actorLevel: "L1",
        entityType: "AvailabilityConfiguration",
        entityId: configId,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: cfg.entryId,
        payload: { configId, roomId: selectedRoomId },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

