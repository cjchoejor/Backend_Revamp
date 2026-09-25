"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSession } from "@/hooks/use-session";
import { deskMoneyFor, deskTimersFor, listDeskBookings, listStaffNames, type DeskMoneyRow } from "@/lib/api/desk";
import { listRooms } from "@/lib/api/rooms";

/** Every booking, as the list screens read it — re-read every minute without a spinner (SS01 §5). */
export function useDeskBookings() {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["desk-bookings"],
    queryFn: () => listDeskBookings(session!),
    enabled: !!session && !isLoading,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * The money line for the bookings on screen (SS01-P3) — each the booking header's own billing
 * summary, asked for a hundred at a time. Each chunk of ids is its own query, so a longer page
 * only asks for the rows it added.
 */
export function useDeskMoney(entryIds: string[]) {
  const { session, isLoading } = useSession();
  const chunks = useMemo(() => {
    const ids = [...new Set(entryIds)];
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) out.push(ids.slice(i, i + 100).sort());
    return out;
  }, [entryIds]);
  const results = useQueries({
    queries: chunks.map((ids) => ({
      queryKey: ["desk-money", ids],
      queryFn: () => deskMoneyFor(session!, ids),
      enabled: !!session && !isLoading,
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join(",");
  const byId = useMemo(() => {
    const m = new Map<string, DeskMoneyRow>();
    for (const r of results) for (const row of r.data?.items ?? []) m.set(row.entryId, row);
    return m;
    // `results` is a new array every render; the update stamps say when it really changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  return { byId, isLoading: results.some((r) => r.isLoading) };
}

/** Staff names by id — for "who recorded it" lines. */
/**
 * The clock running on each booking on screen (2026-09-25). One call for the page, like the money
 * line; refetched every half-minute so a countdown on the list does not drift from the rail's.
 */
export function useDeskTimers(entryIds: string[]) {
  const { session } = useSession();
  const ids = useMemo(() => [...new Set(entryIds)].slice(0, 100).sort(), [entryIds]);
  const q = useQuery({
    queryKey: ["desk-timers", ids],
    queryFn: () => deskTimersFor(session!, ids),
    enabled: !!session && ids.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const byId = useMemo(() => new Map((q.data?.items ?? []).map((r) => [r.entryId, r])), [q.data]);
  return { ...q, byId };
}

export function useStaffNames() {
  const { session, isLoading } = useSession();
  const q = useQuery({
    queryKey: ["desk-staff"],
    queryFn: () => listStaffNames(session!),
    enabled: !!session && !isLoading,
    staleTime: 10 * 60_000,
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const s of q.data?.items ?? []) m.set(s.id, s.fullName);
    return m;
  }, [q.data]);
}

/** The room registry with its live standing — the Rooms board and Today's occupancy line. */
export function useRoomsList() {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["rooms"],
    queryFn: () => listRooms(session!),
    enabled: !!session && !isLoading,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
