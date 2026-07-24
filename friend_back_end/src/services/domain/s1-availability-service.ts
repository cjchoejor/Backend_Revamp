import { Prisma, PartyType } from "@prisma/client";
import type { Entry, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { queryAvailability as availabilityEngineQuery } from "../../engines/availability-engine.js";
import { enforceAvailabilityQueryParamsForS1 } from "../../policies/01-availability/p01-availability-query-params-s1.js";
import { resolveIndicativePricingForS1Availability } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s1-indicative.js";
import { resolveAgentRate } from "../../lib/agent-rate-resolution.js";
import { annotateDeficientRoomSurface } from "../../policies/19-deficient-condition/p02-deficient-condition-surface-policy.js";
import {
  createQuotedSpaceAllocationForAvailabilityQuery,
  isConferenceLikeUseType,
} from "./space-allocation-service.js";

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

/** The indicative-pricing chip shape the S1 availability result carries (mirrors p19's chip). */
type IndicativeChip = {
  rateAmount: number;
  currency: string;
  stayNights: number;
  lineTotalIndicative: number;
  source?: string;
  disclaimer: "INDICATIVE_ONLY_NO_QUOTATION";
};

/**
 * Resolve the negotiated party (travel agent / corporate account) linked to the entry's inquiry,
 * so S1 indicative pricing can reflect the contracted rate instead of the hotel's standard plan.
 * Returns null when the inquiry has no linked party (walk-in / direct) — caller falls back to p19.
 */
async function resolvePartyForEntryInquiry(
  prisma: PrismaClient,
  inquiryId?: string | null,
): Promise<{ partyType: PartyType; partyId: string } | null> {
  if (!inquiryId) return null;
  const inq = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    select: { travelAgentId: true, corporateAccountId: true },
  });
  if (!inq) return null;
  if (inq.travelAgentId) return { partyType: PartyType.TRAVEL_AGENT, partyId: inq.travelAgentId };
  if (inq.corporateAccountId) return { partyType: PartyType.CORPORATE, partyId: inq.corporateAccountId };
  return null;
}

/** Shared engine run for new queries and stale-configuration recall (SIG §6.3). */
async function runAvailabilityEngineForEntry(
  prisma: PrismaClient,
  entry: Pick<Entry, "id" | "guestCount" | "useType" | "otaSource" | "inquiryId">,
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

  // Fetch existing bookings + committed holds that intersect the query range. Used by the
  // engine to compute a per-date breakdown so the S1 calendar can render per-night cells.
  // Excludes the current entry so re-searching an already-sealed booking doesn't mark its
  // own rooms as occupied.
  const [reservations, committedHolds] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        frozenCheckInDate: { lt: checkOut },
        frozenCheckOutDate: { gt: checkIn },
        NOT: { entryId: entry.id },
      },
      select: {
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entry: { select: { roomAssignments: { select: { roomId: true } } } },
      },
    }),
    prisma.committedHold.findMany({
      where: {
        state: { in: ["PLACED", "CONFIRMED"] },
        roomId: { not: null },
        NOT: { entryId: entry.id },
        expiresAt: { gt: new Date() },
        entry: {
          checkInDate: { lt: checkOut },
          checkOutDate: { gt: checkIn },
        },
      },
      select: {
        roomId: true,
        entry: { select: { checkInDate: true, checkOutDate: true } },
      },
    }),
  ]);
  // Fan out reservations to (roomId, start, end) tuples via their entry's room assignments.
  const roomBlockages = [
    ...reservations.flatMap((r) =>
      (r.entry?.roomAssignments ?? []).map((a) => ({
        roomId: a.roomId,
        startDate: r.frozenCheckInDate,
        endDate: r.frozenCheckOutDate,
        source: "RESERVED" as const,
      })),
    ),
    ...committedHolds
      .filter((h) => h.roomId && h.entry?.checkInDate && h.entry?.checkOutDate)
      .map((h) => ({
        roomId: h.roomId!,
        startDate: h.entry!.checkInDate!,
        endDate: h.entry!.checkOutDate!,
        source: "HOLD" as const,
      })),
  ];

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
    roomBlockages,
    currentTimestamp: new Date(),
  });

  // Standard (rack) indicative from the hotel's rate plans — used as the fallback and for walk-ins.
  const indicative = await resolveIndicativePricingForS1Availability(prisma, { checkIn, checkOut }, input.roomTypeId);

  // Contracted-rate override (SIG-S1 §1.6 indicative; Phase B RateCard): if the inquiry is linked to
  // a travel agent or corporate account, surface that party's negotiated per-room-type rate instead
  // of the flat rack plan. Resolved once per distinct room type present in the result.
  const party = await resolvePartyForEntryInquiry(prisma, entry.inquiryId);
  const stayNights = Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
  const agentChipByRoomType = new Map<string, IndicativeChip>();
  if (party) {
    const distinctTypes = new Set<string>();
    for (const r of [...engineRaw.availableRooms, ...engineRaw.deficientRooms] as any[]) {
      if (r.roomTypeId) distinctTypes.add(r.roomTypeId as string);
    }
    for (const roomTypeId of distinctTypes) {
      const br = await resolveAgentRate(prisma, { partyType: party.partyType, partyId: party.partyId, roomTypeId });
      if (br) {
        agentChipByRoomType.set(roomTypeId, {
          rateAmount: br.roomRate,
          currency: br.currency,
          stayNights,
          lineTotalIndicative: br.roomRate * stayNights,
          source: "AGENT_RATE_CARD",
          disclaimer: "INDICATIVE_ONLY_NO_QUOTATION",
        });
      }
    }
  }

  // Per-room indicative: contracted rate for the room's type when available, else the rack indicative.
  const chipForRoom = (r: any): IndicativeChip | null =>
    (r.roomTypeId ? agentChipByRoomType.get(r.roomTypeId) : null) ?? (indicative as IndicativeChip | null);
  const attachPricing = (rooms: any[]) =>
    rooms.map((r) => {
      const chip = chipForRoom(r);
      return chip ? { ...r, pricingIndicative: chip } : r;
    });

  // Top-level banner: representative contracted rate when agent-linked (falls back to rack).
  const topIndicative =
    (party && agentChipByRoomType.size > 0
      ? agentChipByRoomType.get((engineRaw.availableRooms[0] as any)?.roomTypeId) ??
        agentChipByRoomType.values().next().value
      : null) ?? indicative ?? null;

  const engineOutRaw =
    indicative || agentChipByRoomType.size > 0
      ? {
          ...engineRaw,
          availableRooms: attachPricing(engineRaw.availableRooms as any[]),
          deficientRooms: attachPricing(engineRaw.deficientRooms as any[]),
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
    ...(topIndicative ? { indicativePricing: topIndicative } : {}),
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
  input: {
    roomId?: string;
    roomIds?: string[];
    perNight?: Array<{ date: string; roomIds: string[] }>;
    deficientAcknowledgements?: unknown;
  },
) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (cfg.isStale) throw new ValidationError("configuration is stale");

  // Normalise the three input shapes into a single flat list of distinct room ids to validate
  // and a normalised `perNight` list (empty if the caller didn't use that shape). Downstream
  // storage picks the richest shape available:
  //   - perNight provided → { perNight: [...], isDeficient }
  //   - roomIds provided  → { roomIds: [{ roomId, isDeficient }, ...], isDeficient }
  //   - roomId  provided  → { roomId, isDeficient }  (legacy)
  let normalisedPerNight: Array<{ date: string; roomIds: string[] }> = [];
  let rawIds: string[] = [];
  if (input.perNight && input.perNight.length > 0) {
    // Dedup within each night; collect union across nights for the resultSet validation.
    const unique = new Set<string>();
    normalisedPerNight = input.perNight.map((n) => {
      const distinct = Array.from(new Set(n.roomIds.map((r) => r.trim()).filter(Boolean)));
      distinct.forEach((id) => unique.add(id));
      return { date: n.date, roomIds: distinct };
    });
    rawIds = Array.from(unique);
  } else if (input.roomIds && input.roomIds.length > 0) {
    rawIds = input.roomIds;
  } else if (input.roomId) {
    rawIds = [input.roomId];
  }
  const selectedRoomIds = Array.from(new Set(rawIds.map((r) => r.trim()).filter(Boolean)));
  if (selectedRoomIds.length === 0) throw new ValidationError("At least one roomId is required");

  // Guard: each selection must be present in the persisted resultSet and not in the
  // unavailable bucket. Fail-fast per id so the operator sees exactly which one's bad.
  const rs = (cfg.resultSet ?? {}) as any;
  const availableIds = new Set<string>(
    [...(rs.availableRooms ?? []), ...(rs.deficientRooms ?? [])].map((r: any) => r.inventoryId ?? r.roomId),
  );
  const unavailableById = new Map<string, any>(
    (rs.unavailableRooms ?? []).map((r: any) => [r.inventoryId ?? r.roomId, r]),
  );
  for (const id of selectedRoomIds) {
    if (unavailableById.has(id)) {
      const u = unavailableById.get(id);
      throw new ValidationError(`Room ${id} is not selectable (unavailableReason=${u.unavailabilityReason ?? "UNKNOWN"})`);
    }
    if (!availableIds.has(id)) {
      throw new ValidationError(`Room ${id} must be selected from the persisted AvailabilityConfiguration resultSet`);
    }
  }

  // Load all selected rooms once + compute per-room deficient status.
  const rooms = await prisma.room.findMany({
    where: { id: { in: selectedRoomIds } },
    include: { deficientConditionRecords: true },
  });
  if (rooms.length !== selectedRoomIds.length) throw new NotFoundError("Room");
  const perRoom = selectedRoomIds.map((id) => {
    const room = rooms.find((r) => r.id === id)!;
    const isDeficient = (room.deficientConditionRecords ?? []).some((d) => d.status !== "RESOLVED");
    return { roomId: id, isDeficient };
  });

  const anyDeficient = perRoom.some((r) => r.isDeficient);
  if (anyDeficient && !input.deficientAcknowledgements) {
    throw new ValidationError("deficientAcknowledgements is required when any selected room is DEFICIENT");
  }

  // Per-night specific validation. Every night must have the same number of picks (matching
  // entry.numberOfRooms). Cover all nights of the stay — no gaps. Same room can be repeated
  // across nights (guest staying in room 201 all week) but not within one night (that would
  // be a duplicate assignment).
  if (normalisedPerNight.length > 0) {
    const entry = await prisma.entry.findUnique({
      where: { id: cfg.entryId },
      select: { numberOfRooms: true, checkInDate: true, checkOutDate: true },
    });
    if (!entry) throw new NotFoundError("Entry");
    const requiredRooms = entry.numberOfRooms ?? normalisedPerNight[0].roomIds.length;
    for (const n of normalisedPerNight) {
      if (n.roomIds.length !== requiredRooms) {
        throw new ValidationError(
          `Night ${n.date} has ${n.roomIds.length} rooms selected; expected ${requiredRooms} (matching Entry.numberOfRooms).`,
        );
      }
    }
    // Verify all stay nights are covered. Skip if either check-in or check-out is missing —
    // rare but possible for pre-Phase-D entries; we can't derive expected nights without them.
    if (entry.checkInDate && entry.checkOutDate) {
      const expected: string[] = [];
      const cur = new Date(entry.checkInDate.getTime());
      const end = new Date(entry.checkOutDate.getTime());
      while (cur < end) {
        expected.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
        if (expected.length > 365) break;
      }
      const supplied = new Set(normalisedPerNight.map((n) => n.date));
      const missing = expected.filter((d) => !supplied.has(d));
      if (missing.length > 0) {
        throw new ValidationError(`perNight is missing selections for ${missing.length} night(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    // Storage shape picked from richest → simplest:
    //   1) perNight given → `{ perNight: [{ date, roomIds: [{ roomId, isDeficient }] }], isDeficient }`
    //      — the operator committed to specific rooms per night; supports mid-stay room
    //      changes (e.g. room 201 for night 1, room 301 for night 2).
    //   2) roomIds given → `{ roomIds: [{ roomId, isDeficient }, ...] }` — same rooms all nights.
    //   3) single roomId → legacy `{ roomId, isDeficient }` shape preserved.
    const deficientLookup = new Map(perRoom.map((r) => [r.roomId, r.isDeficient]));
    let optionSelected: Record<string, unknown>;
    if (normalisedPerNight.length > 0) {
      optionSelected = {
        perNight: normalisedPerNight.map((n) => ({
          date: n.date,
          roomIds: n.roomIds.map((id) => ({ roomId: id, isDeficient: deficientLookup.get(id) === true })),
        })),
        isDeficient: anyDeficient,
      };
    } else if (perRoom.length === 1) {
      optionSelected = { roomId: perRoom[0].roomId, isDeficient: perRoom[0].isDeficient };
    } else {
      optionSelected = { roomIds: perRoom, isDeficient: anyDeficient };
    }

    const updated = await tx.availabilityConfiguration.update({
      where: { id: configId },
      data: {
        optionSelected: optionSelected as Prisma.InputJsonValue,
        deficientAcknowledgements: anyDeficient ? (input.deficientAcknowledgements as any) : null,
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
        payload: {
          configId,
          roomIds: perRoom.map((r) => r.roomId),
          ...(normalisedPerNight.length > 0 ? { perNight: normalisedPerNight } : {}),
        },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

