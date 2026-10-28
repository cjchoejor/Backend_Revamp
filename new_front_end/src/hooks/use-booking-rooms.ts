"use client";

/**
 * A booking's rooms as the server sees them (2026-10-28): which the system chose and may still move
 * ("Deluxe Double · room 2"), and which are fixed. Re-read whenever the booking changes.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getBookingRooms } from "@/lib/api/booking-rooms";

export function useBookingRooms(entry: { id: string; updatedAt?: string | null } | null | undefined) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["booking-rooms", entry?.id, entry?.updatedAt ?? ""],
    queryFn: () => getBookingRooms(session!, entry!.id),
    enabled: !!session && !!entry?.id,
    staleTime: 15_000,
  });
  const labels = new Map<string, string>();
  for (const r of q.data?.rooms ?? []) if (r.quiet) labels.set(r.roomId, r.label);
  return { data: q.data ?? null, labels, loading: q.isLoading };
}
