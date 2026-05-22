import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type AvailabilityRoomResult = {
  roomId: string;
  roomNumber?: string;
  roomTypeId?: string;
  capacity?: number;
  isDeficient?: boolean;
  deficientConditionCategory?: string | null;
  unavailabilityReason?: string;
  pricingIndicative?: unknown;
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
} {
  const rs = (resultSet ?? {}) as {
    availableRooms?: Array<Record<string, unknown>>;
    deficientRooms?: Array<Record<string, unknown>>;
  };
  const mapRoom = (r: Record<string, unknown>): AvailabilityRoomResult => ({
    roomId: String(r.roomId ?? r.inventoryId ?? ""),
    roomNumber: r.roomNumber as string | undefined,
    roomTypeId: r.roomTypeId as string | undefined,
    capacity: typeof r.capacity === "number" ? r.capacity : undefined,
    isDeficient: r.isDeficient as boolean | undefined,
    deficientConditionCategory: r.deficientConditionCategory as string | null | undefined,
    unavailabilityReason: r.unavailabilityReason as string | undefined,
    pricingIndicative: r.pricingIndicative,
  });
  return {
    availableRooms: (rs.availableRooms ?? []).map(mapRoom).filter((r) => r.roomId),
    deficientRooms: (rs.deficientRooms ?? []).map(mapRoom).filter((r) => r.roomId),
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
  body: { roomId: string; deficientAcknowledgements?: unknown },
) {
  return apiRequest<{
    id: string;
    entryId: string;
    optionSelected: { roomId: string; isDeficient?: boolean } | null;
    isStale: boolean;
    sealedAt: string | null;
  }>(`/api/availability/configurations/${configurationId}/select`, {
    method: "PATCH",
    session,
    body,
  });
}
