"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getHousekeepingBoard } from "@/lib/api/housekeeping";

/** Which rooms need cleaning — re-read every minute, so a room marked clean on another screen (or
 *  later, on a housekeeping phone) shows here without a reload. */
export function useHousekeepingBoard() {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["housekeeping-board"],
    queryFn: () => getHousekeepingBoard(session!),
    enabled: !!session && !isLoading,
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
