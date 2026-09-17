"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getHotelDay, type HotelDay } from "@/lib/api/hotel-day";

/**
 * What day it is AT THE HOTEL — the only "today" the desk may use (2026-09-17).
 *
 * The desk used to work this out itself, two different ways: `new Date()`'s local date (the
 * machine's timezone setting) in some places, and `new Date().toISOString().slice(0, 10)` (the
 * UTC date) in others. Neither is the hotel's day. The UTC date is still yesterday in Bhutan
 * until 06:00, so even a correctly set desk disagreed with the server every morning; a machine
 * set to another zone disagreed for longer, in either direction. Every rule that matters — the
 * night audit, early departure, key return, charge dating — is judged by the server on the
 * hotel's calendar, so the desk now asks the server rather than guessing.
 *
 * Returns `null` until the first answer arrives. Callers must treat that as "not known yet"
 * and hold anything the date decides (a gate stays locked, a cap stays shut) rather than fall
 * back to the machine clock — a fallback would quietly bring the old bug back.
 *
 * Polled every minute so the day rolls over at midnight without a reload, and refetched when
 * the window regains focus (a laptop opened the next morning).
 */
export function useHotelDay(): HotelDay | null {
  const { session, isLoading } = useSession();
  const q = useQuery({
    queryKey: ["hotel-day"],
    queryFn: () => getHotelDay(session!),
    enabled: !!session && !isLoading,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return q.data ?? null;
}
