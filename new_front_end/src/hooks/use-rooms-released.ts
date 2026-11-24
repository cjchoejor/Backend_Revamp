"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRoomsReleased } from "@/lib/api/post-stay";
import type { EntryDetail } from "@/types/api";

/**
 * Has the guest left every room this booking held (2026-11-24)? The backend reads it off the
 * booking's own record — never the room's flag as it is now, which housekeeping's clean or the next
 * guest's check-in changes — so Check-out's list and the move to Closed give one answer. Keyed on
 * the booking's last change, so the settlement that releases the rooms re-reads it.
 */
export function useRoomsReleased(entry: EntryDetail | null | undefined, enabled = true) {
  const { session, isLoading } = useSession();
  return useQuery({
    queryKey: ["rooms-released", entry?.id ?? "", entry?.updatedAt ?? "", entry?.folio?.state ?? ""],
    queryFn: () => getRoomsReleased(session!, entry!.id),
    enabled: enabled && !!entry && !!session && !isLoading,
  });
}
