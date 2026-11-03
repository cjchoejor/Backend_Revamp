"use client";

import { useEffect, useRef } from "react";
import type { AllowedRoomCountsResponse } from "@/lib/api/child-policy";

/**
 * The room count follows the party (2026-11-03, operator: "when number of adults are picked … place
 * two in each room"), on every screen that asks both: the new inquiry, the booking's Inquiry step
 * and Change the dates, rooms or guests. The figure is the server's (`suggestedRoomCount`); this
 * only decides when it is applied.
 *
 * It moves when the chargeable guests change, so an under-11's age, which changes nothing, leaves a
 * count the desk picked alone. A count already on the booking is left alone on arrival, and when
 * the party goes back to the one on file, so does the count. A bed ask is the floor: asking for four
 * beds needs four rooms, whatever the party would start on.
 */
export function useRoomsFollowParty({
  env,
  partyEdited,
  rooms,
  savedRooms,
  bedAsk = 0,
  apply,
}: {
  env: AllowedRoomCountsResponse | null | undefined;
  /** The party differs from the one on file. A new inquiry has none on file, so it is always true. */
  partyEdited: boolean;
  rooms: number;
  savedRooms?: number;
  bedAsk?: number;
  apply: (rooms: number) => void;
}) {
  const seen = useRef<number | null>(null);
  const chargeable = env?.chargeableOccupants ?? null;
  const min = env?.allowedRoomCounts.min ?? null;
  const max = env?.allowedRoomCounts.max ?? null;
  useEffect(() => {
    if (!env || chargeable == null || min == null || max == null) return;
    const first = seen.current == null;
    const moved = seen.current !== chargeable;
    seen.current = chargeable;
    if (!partyEdited) {
      if (moved && !first && savedRooms != null) apply(savedRooms);
      return;
    }
    // An answer the browser held from before the figure existed has none: start on the fewest allowed.
    const wanted = Number.isFinite(env.suggestedRoomCount) ? env.suggestedRoomCount : min;
    if (moved || rooms < min || rooms > max) apply(Math.min(max, Math.max(wanted, bedAsk)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargeable, min, max, partyEdited]);
}
