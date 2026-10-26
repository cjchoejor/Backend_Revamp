"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRoomInspections } from "@/lib/api/post-stay";
import type { EntryDetail } from "@/types/api";

/**
 * Each room's inspection — the rooms the guest leaves at check-out, one inspection per room
 * (2026-10-26). The backend decides which rooms they are and where each stands, so the
 * Check-out step, its gate line and the departure handoff read one answer. Keyed on the booking's
 * own inspection rows so a recorded inspection re-reads it; polled while a window can lapse.
 */
export function useRoomInspections(entry: EntryDetail | null | undefined, enabled = true) {
  const { session, isLoading } = useSession();
  const rows = entry?.roomInspectionRecords ?? [];
  return useQuery({
    queryKey: ["room-inspections", entry?.id ?? "", rows.length, rows[0]?.id ?? "", entry?.updatedAt ?? ""],
    queryFn: () => getRoomInspections(session!, entry!.id),
    enabled: enabled && !!entry && !!session && !isLoading,
    refetchInterval: 60_000,
  });
}
