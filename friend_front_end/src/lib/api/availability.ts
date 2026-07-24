import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type AvailabilityRoomResult = {
  roomId: string;
  roomNumber?: string;
  roomTypeId?: string;
  roomTypeName?: string | null;
  capacity?: number;
  isDeficient?: boolean;
  deficientConditionCategory?: string | null;
  claimState?: string;
  unavailabilityReason?: string;
  blockedReason?: string | null;
  pricingIndicative?: unknown;
};

export type PerDateAvailabilityResult = {
  date: string;
  availableRoomIds: string[];
  occupiedRoomIds: Array<{ roomId: string; source: "RESERVED" | "HOLD" }>;
  deficientRoomIds: string[];
};

export type AvailabilityQueryResponse = {
  configurationId: string;
  entryId: string;
  queriedAt: string;
  isStale: boolean;
  results: {
    availableRooms?: AvailabilityRoomResult[];
    deficientRooms?: AvailabilityRoomResult[];
    unavailableRooms?: AvailabilityRoomResult[];
    /** Per-date breakdown (Phase 2.5). Absent when the backend engine ran date-blind. */
    perDate?: PerDateAvailabilityResult[];
    indicativePricing?: unknown;
  };
};

type AvailabilityQueryRawResponse = {
  configuration: {
    id: string;
    entryId: string;
    createdAt: string;
    isStale: boolean;
  };
  result: AvailabilityQueryResponse["results"];
};

export function normalizeAvailabilityQuery(raw: AvailabilityQueryRawResponse): AvailabilityQueryResponse {
  return {
    configurationId: raw.configuration.id,
    entryId: raw.configuration.entryId,
    queriedAt: raw.configuration.createdAt,
    isStale: raw.configuration.isStale,
    results: raw.result,
  };
}

export function roomsFromResultSet(resultSet: unknown): {
  availableRooms: AvailabilityRoomResult[];
  deficientRooms: AvailabilityRoomResult[];
  unavailableRooms: AvailabilityRoomResult[];
} {
  const rs = (resultSet ?? {}) as {
    availableRooms?: Array<Record<string, unknown>>;
    deficientRooms?: Array<Record<string, unknown>>;
    unavailableRooms?: Array<Record<string, unknown>>;
  };
  const mapRoom = (r: Record<string, unknown>): AvailabilityRoomResult => ({
    roomId: String(r.roomId ?? r.inventoryId ?? ""),
    roomNumber: r.roomNumber as string | undefined,
    roomTypeId: r.roomTypeId as string | undefined,
    roomTypeName: (r.roomTypeName as string | null | undefined) ?? undefined,
    capacity: typeof r.capacity === "number" ? r.capacity : undefined,
    isDeficient: r.isDeficient as boolean | undefined,
    deficientConditionCategory: r.deficientConditionCategory as string | null | undefined,
    claimState: r.claimState as string | undefined,
    unavailabilityReason: r.unavailabilityReason as string | undefined,
    blockedReason: r.blockedReason as string | null | undefined,
    pricingIndicative: r.pricingIndicative,
  });
  const filterValid = (rooms: AvailabilityRoomResult[]) => rooms.filter((r) => r.roomId);
  return {
    availableRooms: filterValid((rs.availableRooms ?? []).map(mapRoom)),
    deficientRooms: filterValid((rs.deficientRooms ?? []).map(mapRoom)),
    unavailableRooms: filterValid((rs.unavailableRooms ?? []).map(mapRoom)),
  };
}

export async function queryAvailabilityByEntry(
  session: Session,
  entryId: string,
  body: {
    checkInDate: string;
    checkOutDate: string;
    guestCount?: number;
    useType?: string;
    roomTypeId?: string;
  },
) {
  const raw = await apiRequest<AvailabilityQueryRawResponse>(`/api/entries/${entryId}/availability/query`, {
    method: "POST",
    session,
    body,
  });
  return normalizeAvailabilityQuery(raw);
}

export async function selectAvailabilityOption(
  session: Session,
  configurationId: string,
  body: {
    roomId?: string;
    roomIds?: string[];
    perNight?: Array<{ date: string; roomIds: string[] }>;
    deficientAcknowledgements?: unknown;
  },
) {
  return apiRequest<{
    id: string;
    entryId: string;
    optionSelected:
      | { roomId: string; isDeficient?: boolean }
      | { roomIds: Array<{ roomId: string; isDeficient: boolean }>; isDeficient?: boolean }
      | { perNight: Array<{ date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> }>; isDeficient?: boolean }
      | null;
    isStale: boolean;
    sealedAt: string | null;
  }>(`/api/availability/configurations/${configurationId}/select`, {
    method: "PATCH",
    session,
    body,
  });
}
