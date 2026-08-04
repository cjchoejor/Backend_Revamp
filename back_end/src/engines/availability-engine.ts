import type { EntryUseType, InventoryClaimState } from "@prisma/client";

export type ShadowInventoryRule = {
  actorLevel?: string;
  visible: boolean;
};

export type RoomAvailabilityRecord = {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  currentClaimState: InventoryClaimState;
  isShadowInventory?: boolean;
  isDeficient: boolean;
  deficientConditionCategory?: string | null;
  isUnderMaintenance: boolean;
  maintenanceDeadline?: Date | null;
  isBlocked: boolean;
  blockedReason?: string | null;
};

export type SpaceAvailabilityRecord = {
  id: string;
  spaceName?: string;
  defaultCapacity: number;
  isAvailable: boolean;
  isEventInProgress: boolean;
};

/**
 * A room's existing booking / hold in the calendar. Used by the per-date breakdown to mark
 * cells occupied. `endDate` is the EXCLUSIVE checkout — the night before it counts as
 * occupied; the day of endDate is available. Matches how the frozen dates are stored
 * (frozenCheckInDate inclusive, frozenCheckOutDate exclusive).
 */
export type RoomBlockage = {
  roomId: string;
  startDate: Date;
  endDate: Date;
  /** For debugging / operator display. RESERVED = confirmed booking; HOLD = committed hold. */
  source: "RESERVED" | "HOLD";
  /** ID + readable ref of the booking so the frontend can show WHO holds the room on this night. */
  entryId?: string;
  entryReferenceNumber?: string | null; // e.g. "INQ-20260716-0005"
  guestName?: string | null; // "First Last" or "Guest" fallback
  /** Guest contact so the operator can reach out from the availability tooltip. */
  guestPhone?: string | null;
  guestEmail?: string | null;
  /** Booked via a travel agent or corporate account? Empty when direct. */
  agentType?: "TRAVEL_AGENT" | "CORPORATE" | null;
  agentName?: string | null;
  agentPhone?: string | null;
  agentEmail?: string | null;
};

export type AvailabilityInput = {
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId?: string;
  spaceId?: string;
  guestCount: number;
  useType: EntryUseType;
  otaSource: boolean;
  guestTier: string;
  actorLevel?: string;
  agentTier?: string;
  shadowInventoryRules: ShadowInventoryRule[];
  bookablePhysicalStates: InventoryClaimState[];
  rooms: RoomAvailabilityRecord[];
  spaces: SpaceAvailabilityRecord[];
  /**
   * Optional existing room blockages (reservations + committed holds). When supplied, the
   * engine computes a per-date breakdown showing which (room, date) cells are occupied.
   * When omitted, the engine falls back to date-blind behavior (only currentClaimState).
   */
  roomBlockages?: RoomBlockage[];
  currentTimestamp: Date;
};

export type AvailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  claimState: InventoryClaimState;
  pricingIndicative?: unknown;
};

export type DeficientRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  claimState: InventoryClaimState;
  deficientCategory?: string | null;
  deficientDescription?: string | null;
};

export type UnavailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  unavailabilityReason: "CLAIMED" | "MAINTENANCE_CONFLICT" | "BLOCKED" | "PHYSICAL_NOT_READY";
  /** Present when reason is CLAIMED or PHYSICAL_NOT_READY — actual inventory claim on the room. */
  claimState?: InventoryClaimState;
  blockedReason?: string | null;
  /**
   * When a room's whole-stay bucket is UNAVAILABLE because a specific booking overlaps the
   * search range, surface WHICH booking so the operator can find the guest. Only populated
   * when the engine received `roomBlockages` and at least one blockage covers this room.
   */
  occupiedBy?: Array<{
    source: "RESERVED" | "HOLD";
    entryId?: string;
    entryReferenceNumber?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    guestEmail?: string | null;
    agentType?: "TRAVEL_AGENT" | "CORPORATE" | null;
    agentName?: string | null;
    agentPhone?: string | null;
    agentEmail?: string | null;
    startDate: string; // ISO date
    endDate: string; // ISO date (exclusive)
  }>;
};

export type MaintenanceConflictEntry = {
  inventoryId: string;
  maintenanceDeadline: Date;
};

/** Per-date row in the availability breakdown. `date` is the ISO YYYY-MM-DD of the night. */
export type PerDateAvailability = {
  date: string;
  /** Room ids available on this specific night. */
  availableRoomIds: string[];
  /**
   * Rooms with a blocking reservation / hold on this night.
   *
   * `entryId`, `entryReferenceNumber`, and `guestName` are surfaced so the operator can see
   * WHO booked the room — not just that it's taken. Frontend uses this in tooltips /
   * per-cell context menus.
   */
  occupiedRoomIds: Array<{
    roomId: string;
    source: "RESERVED" | "HOLD";
    entryId?: string;
    entryReferenceNumber?: string | null;
    guestName?: string | null;
    guestPhone?: string | null;
    guestEmail?: string | null;
    agentType?: "TRAVEL_AGENT" | "CORPORATE" | null;
    agentName?: string | null;
    agentPhone?: string | null;
    agentEmail?: string | null;
  }>;
  /** Rooms flagged deficient — same set on every night since deficiency is room-scoped. */
  deficientRoomIds: string[];
};

export type AvailabilityResult = {
  availableRooms: AvailableRoomEntry[];
  unavailableRooms: UnavailableRoomEntry[];
  deficientRooms: DeficientRoomEntry[];
  maintenanceConflicts: MaintenanceConflictEntry[];
  /** Present when caller supplied `roomBlockages`. Absent → engine ran in legacy date-blind mode. */
  perDate?: PerDateAvailability[];
  searchTimestamp: Date;
  isRevalidationRequired: boolean;
};

function isDateInRangeInclusive(d: Date, start: Date, end: Date) {
  return d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
}

export function queryAvailability(input: AvailabilityInput): AvailabilityResult {
  const availableRooms: AvailableRoomEntry[] = [];
  const unavailableRooms: UnavailableRoomEntry[] = [];
  const deficientRooms: DeficientRoomEntry[] = [];
  const maintenanceConflicts: MaintenanceConflictEntry[] = [];

  const rooms = input.roomTypeId ? input.rooms.filter((r) => r.roomTypeId === input.roomTypeId) : input.rooms;

  // Pre-index blockages by roomId so both the whole-range gate and the per-date loop can
  // consult them without rescanning. A room has an "in-range blockage" when any of its
  // blockages' [startDate, endDate) intersects with the search range [checkIn, checkOut).
  const blockagesByRoomId = new Map<string, RoomBlockage[]>();
  if (Array.isArray(input.roomBlockages)) {
    for (const b of input.roomBlockages) {
      if (!blockagesByRoomId.has(b.roomId)) blockagesByRoomId.set(b.roomId, []);
      blockagesByRoomId.get(b.roomId)!.push(b);
    }
  }
  const searchStart = input.checkInDate;
  const searchEnd = input.checkOutDate;
  const inRangeBlockagesForRoom = (roomId: string): RoomBlockage[] => {
    const list = blockagesByRoomId.get(roomId);
    if (!list) return [];
    return list.filter((b) => b.startDate < searchEnd && b.endDate > searchStart);
  };

  // Policy 14 (Shadow inventory visibility): if room is shadow, visibility depends on rules for actor level.
  const actorLevel = input.actorLevel ?? "L1";
  const shadowRule = (input.shadowInventoryRules ?? []).find((r) => String(r.actorLevel ?? "").toUpperCase() === String(actorLevel).toUpperCase());
  const showShadow = shadowRule ? shadowRule.visible === true : true;

  for (const room of rooms) {
    if (room.isShadowInventory === true && !showShadow) {
      continue;
    }

    // 2026-07-25: If the caller supplied roomBlockages AND any blockage overlaps the search
    // range, the room CANNOT satisfy the whole-stay booking — put it in unavailableRooms with
    // occupiedBy context. Per-date loop below still runs to expose the specific nights.
    // This is the authoritative check for future-date availability (currentClaimState is a
    // NOW snapshot that goes stale the moment a booking ends).
    const overlappingBlockages = inRangeBlockagesForRoom(room.id);
    if (overlappingBlockages.length > 0) {
      unavailableRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        unavailabilityReason: "CLAIMED",
        claimState: room.currentClaimState,
        occupiedBy: overlappingBlockages.map((b) => ({
          source: b.source,
          entryId: b.entryId,
          entryReferenceNumber: b.entryReferenceNumber ?? null,
          guestName: b.guestName ?? null,
          guestPhone: b.guestPhone ?? null,
          guestEmail: b.guestEmail ?? null,
          agentType: b.agentType ?? null,
          agentName: b.agentName ?? null,
          agentPhone: b.agentPhone ?? null,
          agentEmail: b.agentEmail ?? null,
          startDate: b.startDate.toISOString(),
          endDate: b.endDate.toISOString(),
        })),
      });
      continue;
    }

    // Policy 1: only configured bookable claim states are candidates for the whole-stay bucket.
    //
    // This check actually operates on `currentClaimState` (a Model 1 field) despite its
    // "bookablePhysicalStates" config name. When per-date data is being computed via
    // `roomBlockages`, we DON'T short-circuit here — the room needs to reach the per-date
    // loop so specific-night occupancy is calculated. Without this, the same bug we fixed
    // for the CLAIMED check below re-emerges: rooms with a live claim state get painted
    // occupied on every date, including months with no reservation.
    if (
      Array.isArray(input.bookablePhysicalStates) &&
      input.bookablePhysicalStates.length > 0 &&
      !input.bookablePhysicalStates.includes(room.currentClaimState)
    ) {
      if (!Array.isArray(input.roomBlockages)) {
        unavailableRooms.push({
          inventoryId: room.id,
          roomNumber: room.roomNumber,
          unavailabilityReason: "PHYSICAL_NOT_READY",
          claimState: room.currentClaimState,
        });
        continue;
      }
      // Fall through — per-date loop below decides per-night status via roomBlockages.
    }

    // Model 1 claim state.
    //
    // A non-FREE claim state (CONFIRMED, OCCUPIED, DEPARTED_DIRTY, etc.) means the room has
    // an active commercial claim TODAY — but the claim ends at some point, and the room
    // becomes bookable again for future dates. `currentClaimState` is a snapshot, not a
    // per-date view.
    //
    // BUG we're fixing (2026-07-24): the previous code put every non-FREE room into
    // `unavailableRooms` and excluded it from `candidateRoomIds`, so the per-date breakdown
    // NEVER got a chance to compute. The frontend then fell back to the whole-range bucket
    // and painted the room as occupied on EVERY visible date across every month — even
    // months with no reservation whatsoever.
    //
    // The correct behaviour: when the caller has supplied `roomBlockages`, the per-date view
    // is authoritative. Non-FREE rooms stay in the candidate pool; the per-date loop marks
    // ONLY the actually-overlapping nights as occupied. When no roomBlockages were supplied,
    // fall back to the legacy behaviour so callers that expect the whole-stay classification
    // still work.
    if (room.currentClaimState !== "FREE") {
      if (!Array.isArray(input.roomBlockages)) {
        unavailableRooms.push({
          inventoryId: room.id,
          roomNumber: room.roomNumber,
          unavailabilityReason: "CLAIMED",
          claimState: room.currentClaimState,
        });
        continue;
      }
      // Fall through — per-date loop below decides per-night status via the roomBlockages
      // intersection. Room enters availableRooms as a candidate; if it has an intersecting
      // blockage in the search range it will ALSO be reflected in the per-date `occupiedRoomIds`.
    }

    // Hardcoded floor: blocked is always a conflict
    if (room.isBlocked) {
      unavailableRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        unavailabilityReason: "BLOCKED",
        blockedReason: room.blockedReason ?? null,
      });
      continue;
    }

    // Hardcoded floor: maintenance with deadline within range is always conflict
    if (room.isUnderMaintenance && room.maintenanceDeadline && isDateInRangeInclusive(room.maintenanceDeadline, input.checkInDate, input.checkOutDate)) {
      unavailableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, unavailabilityReason: "MAINTENANCE_CONFLICT" });
      maintenanceConflicts.push({ inventoryId: room.id, maintenanceDeadline: room.maintenanceDeadline });
      continue;
    }

    // Policy 2 / AC-S1-012: deficient rooms never appear in availableRooms
    if (room.isDeficient) {
      deficientRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        claimState: room.currentClaimState,
        deficientCategory: room.deficientConditionCategory ?? null,
        deficientDescription: null,
      });
      continue;
    }

    availableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, claimState: room.currentClaimState });
  }

  // ---- Per-date breakdown ------------------------------------------------
  // When the caller supplied roomBlockages, build a per-night breakdown of which rooms are
  // truly available on which specific night. The whole-range buckets above answer "usable
  // for the whole stay" — this breakdown answers "usable on each individual night" and
  // powers the calendar cell colours in the S1 UI.
  let perDate: PerDateAvailability[] | undefined = undefined;
  if (Array.isArray(input.roomBlockages)) {
    perDate = [];
    // blockagesByRoomId already built above (top of queryAvailability) — reuse.
    const deficientRoomIdSet = new Set(deficientRooms.map((r) => r.inventoryId));
    // Include rooms in ALL buckets — the frontend renders every room and needs to know which
    // ones are occupied on which specific date. Now that the whole-range gate puts rooms
    // with any range-overlapping blockage into unavailableRooms, we must include those here
    // too — otherwise their per-date cells go blank and the frontend can't render the
    // occupied-status tooltip on the specific nights.
    const candidateRoomIds = new Set<string>([
      ...availableRooms.map((r) => r.inventoryId),
      ...deficientRooms.map((r) => r.inventoryId),
      ...unavailableRooms.filter((r) => r.unavailabilityReason === "CLAIMED").map((r) => r.inventoryId),
    ]);

    const cur = new Date(input.checkInDate);
    const end = new Date(input.checkOutDate);
    let safety = 0;
    while (cur < end && safety++ < 365) {
      const iso = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
      const nightStart = new Date(cur.getTime());
      const nightEnd = new Date(cur.getTime() + 86_400_000);
      const availableIds: string[] = [];
      const occupied: PerDateAvailability["occupiedRoomIds"] = [];
      const deficientIds: string[] = [];
      for (const roomId of candidateRoomIds) {
        const bs = blockagesByRoomId.get(roomId) ?? [];
        // A blockage intersects this night when its [startDate, endDate) overlaps with the
        // night's [nightStart, nightEnd). Standard half-open interval intersection test.
        const blocking = bs.find((b) => b.startDate < nightEnd && b.endDate > nightStart);
        if (blocking) {
          // Carry through booking context so the frontend can show WHO holds the room.
          // (Only the service supplies these fields; if a caller passes bare RoomBlockage
          // objects without them, they'll be undefined here and the frontend will just show
          // "Occupied" with no name.)
          occupied.push({
            roomId,
            source: blocking.source,
            entryId: blocking.entryId,
            entryReferenceNumber: blocking.entryReferenceNumber ?? null,
            guestName: blocking.guestName ?? null,
            guestPhone: blocking.guestPhone ?? null,
            guestEmail: blocking.guestEmail ?? null,
            agentType: blocking.agentType ?? null,
            agentName: blocking.agentName ?? null,
            agentPhone: blocking.agentPhone ?? null,
            agentEmail: blocking.agentEmail ?? null,
          });
          continue;
        }
        if (deficientRoomIdSet.has(roomId)) {
          deficientIds.push(roomId);
          continue;
        }
        availableIds.push(roomId);
      }
      perDate.push({ date: iso, availableRoomIds: availableIds, occupiedRoomIds: occupied, deficientRoomIds: deficientIds });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    // Enrich unavailableRooms entries with the booking context — same info, whole-stay view.
    // Frontend can display "Occupied by X (INQ-…)" on rooms it never renders as per-date
    // cells because the whole-range bucket was UNAVAILABLE (e.g. BLOCKED / MAINTENANCE
    // rooms with an overlapping reservation would still show WHO holds it).
    for (const u of unavailableRooms) {
      const bs = blockagesByRoomId.get(u.inventoryId) ?? [];
      if (bs.length === 0) continue;
      u.occupiedBy = bs.map((b) => ({
        source: b.source,
        entryId: b.entryId,
        entryReferenceNumber: b.entryReferenceNumber ?? null,
        guestName: b.guestName ?? null,
        guestPhone: b.guestPhone ?? null,
        guestEmail: b.guestEmail ?? null,
        agentType: b.agentType ?? null,
        agentName: b.agentName ?? null,
        agentPhone: b.agentPhone ?? null,
        agentEmail: b.agentEmail ?? null,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
      }));
    }
  }

  return {
    availableRooms,
    unavailableRooms,
    deficientRooms,
    maintenanceConflicts,
    ...(perDate ? { perDate } : {}),
    searchTimestamp: input.currentTimestamp,
    isRevalidationRequired: false,
  };
}

