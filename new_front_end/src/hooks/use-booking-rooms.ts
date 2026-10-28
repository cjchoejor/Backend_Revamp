"use client";

/**
 * A booking's rooms as the server sees them (2026-10-28): which the system chose and may still move
 * ("Deluxe Double · room 2"), and which are fixed. Re-read whenever the booking changes.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getBookingRooms } from "@/lib/api/booking-rooms";

/** A room the system chose and may still move: its type, its number within the type, its label. */
export type RoomByType = { typeName: string; ordinal: number | null; label: string };

export function useBookingRooms(entry: { id: string; updatedAt?: string | null } | null | undefined) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["booking-rooms", entry?.id, entry?.updatedAt ?? ""],
    queryFn: () => getBookingRooms(session!, entry!.id),
    enabled: !!session && !!entry?.id,
    staleTime: 15_000,
  });
  const labels = new Map<string, string>();
  const named = new Map<string, RoomByType>();
  // The same, keyed by room NUMBER — for reads that carry numbers only (the reservation's figures).
  const byNumber = new Map<string, string>();
  // The rooms the system chose and may still move; at Arrival they are its PROPOSAL, named by
  // number (so the maps above stay empty there) for the desk to confirm or change.
  const quiet = (q.data?.rooms ?? []).filter((r) => r.quiet);
  const atArrival = q.data?.atArrival === true;
  if (!atArrival)
    for (const r of quiet) {
      labels.set(r.roomId, r.label);
      named.set(r.roomId, { typeName: r.typeName, ordinal: r.ordinal, label: r.label });
      if (r.roomNumber) byNumber.set(r.roomNumber, r.label);
    }
  const quietIds = new Set(quiet.map((r) => r.roomId));
  return { data: q.data ?? null, labels, named, byNumber, quietIds, proposals: atArrival ? quiet : [], atArrival, loading: q.isLoading };
}
