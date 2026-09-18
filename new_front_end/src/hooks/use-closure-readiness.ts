"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getClosureReadiness } from "@/lib/api/post-stay";

/**
 * What still stands between a booking and "Close & seal" — the backend's own checks, so the gate
 * bar and the Closed step can never call a booking ready that the close refuses (or the reverse).
 * Polled each minute: the inspection window can lapse on its own while the page is open.
 */
export function useClosureReadiness(entryId: string, enabled: boolean) {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["closure-readiness", entryId],
    queryFn: () => getClosureReadiness(session!, entryId),
    enabled: enabled && !!session && !isLoading,
    refetchInterval: 60_000,
  });
}
