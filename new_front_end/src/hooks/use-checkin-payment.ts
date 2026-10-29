"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getCheckInPayment } from "@/lib/api/checkin-payment";

/**
 * Where the rest of the bill stands before check-in (2026-10-29) — the guest's promise, the
 * server's still-to-pay, the request to the FOM and the FOM's decision. Read again whenever the
 * booking changes, and shared by the Check-in section and the workspace's to-do list.
 */
export function useCheckInPayment(entryId: string | null | undefined, version: string | null | undefined, opts?: { enabled?: boolean }) {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["checkin-payment", entryId, version ?? null],
    queryFn: () => getCheckInPayment(session!, entryId!),
    enabled: !!session && !isLoading && !!entryId && opts?.enabled !== false,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
