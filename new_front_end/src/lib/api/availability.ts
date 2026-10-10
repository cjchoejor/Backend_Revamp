import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Booking context surfaced next to each occupied room so the operator can see WHO holds
 * the room. Populated from the backend's blockage enrichment (2026-07-24, extended 2026-07-25
 * with contact details + agent/corporate info). Fields are optional so older backend versions
 * still typecheck.
 */
export type OccupancyContext = {
  entryId?: string;
  entryReferenceNumber?: string | null; // e.g. "INQ-20260716-0005"
  guestName?: string | null;
  guestPhone?: string | null;
  guestEmail?: string | null;
  agentType?: "TRAVEL_AGENT" | "CORPORATE" | null;
  agentName?: string | null;
  agentPhone?: string | null;
  agentEmail?: string | null;
};

export type AvailabilityRoomResult = {
  roomId: string;
  roomNumber?: string;
  roomTypeId?: string;
  roomTypeName?: string | null;
  isDeficient?: boolean;
  deficientConditionCategory?: string | null;
  claimState?: string;
  unavailabilityReason?: string;
  blockedReason?: string | null;
  pricingIndicative?: unknown;
  /**
   * Present when the whole-stay UNAVAILABLE room has one or more overlapping bookings.
   * Frontend can show a list of "Occupied by X (INQ-…) 25/07-26/07" tooltips.
   */
  occupiedBy?: Array<
    OccupancyContext & {
      source: "RESERVED" | "HOLD";
      startDate: string; // ISO
      endDate: string; // ISO (exclusive)
    }
  >;
};

export type PerDateAvailabilityResult = {
  date: string;
  availableRoomIds: string[];
  /** Each occupied cell carries WHO holds it so the calendar tooltip can name the guest. */
  occupiedRoomIds: Array<
    OccupancyContext & { roomId: string; source: "RESERVED" | "HOLD" }
  >;
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
    isDeficient: r.isDeficient as boolean | undefined,
    deficientConditionCategory: r.deficientConditionCategory as string | null | undefined,
    claimState: r.claimState as string | undefined,
    unavailabilityReason: r.unavailabilityReason as string | undefined,
    blockedReason: r.blockedReason as string | null | undefined,
    pricingIndicative: r.pricingIndicative,
    occupiedBy: Array.isArray(r.occupiedBy)
      ? (r.occupiedBy as AvailabilityRoomResult["occupiedBy"])
      : undefined,
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

/**
 * What the rooms on the S1 table cost — night by night and for the whole stay (2026-10-10).
 * The SERVER's figures (room only, at the rate the quotation defaults to, taxes compound): the
 * desk prints them and never adds anything up. Nothing is saved by asking.
 */
export type PickPricing = {
  entryId: string;
  currency: string;
  serviceChargeRate: number;
  gstRate: number;
  party: { type: "TRAVEL_AGENT" | "CORPORATE"; name: string } | null;
  stayNights: number;
  nights: Array<{
    date: string;
    nightNo: number;
    rooms: Array<{ roomId: string; roomNumber: string; roomTypeId: string | null; roomTypeName: string | null; rate: number | null }>;
    net: number;
    serviceCharge: number;
    gst: number;
    total: number;
    unpricedRooms: number;
  }>;
  byType: Array<{
    roomTypeId: string;
    code: string | null;
    name: string;
    roomNights: number;
    rate: number | null;
    rateSource: "AGENT_RATE_PACKAGE" | "STANDARD_RATE_PLAN" | null;
    packageName: string | null;
    net: number | null;
  }>;
  byRoom: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; dates: string[] }>;
  totals: { roomNights: number; net: number; serviceCharge: number; gst: number; total: number };
  unpricedTypes: Array<{ roomTypeId: string; name: string }>;
};

export function pricePick(session: Session, entryId: string, body: { perNight: Array<{ date: string; roomIds: string[] }> }) {
  return apiRequest<PickPricing>(`/api/entries/${entryId}/availability/price-pick`, { method: "POST", session, body });
}
