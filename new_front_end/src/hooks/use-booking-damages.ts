"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getBookingDamages } from "@/lib/api/damages";
import type { EntryDetail } from "@/types/api";

/**
 * The damage a booking's inspections found and how each was answered (2026-10-26). Keyed on the
 * booking's own inspection rows and its version, so a recorded inspection or an answer re-reads it.
 */
export function useBookingDamages(entry: EntryDetail | null | undefined, enabled = true) {
  const { session, isLoading } = useSession();
  const rows = entry?.roomInspectionRecords ?? [];
  return useQuery({
    queryKey: ["damages", entry?.id ?? "", rows.length, rows[0]?.id ?? "", entry?.updatedAt ?? ""],
    queryFn: () => getBookingDamages(session!, entry!.id),
    enabled: enabled && !!entry && !!session && !isLoading,
  });
}
