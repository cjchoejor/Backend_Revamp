"use client";

import { useQueries } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getEntry } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";

/** Raised when a stay's fields are saved: its house is asked again for the dates just saved. */
export const STAY_SAVED_EVENT = "desk:stay-saved";
export type StaySaved = { checkInDate: string; checkOutDate: string; guestCount?: number | null };

/**
 * A trip at Inquiry (2026-11-07, operator: "stage one can be done together here"): this booking's
 * other live stays still at Inquiry, read in full, numbered as the trip numbers them. Nothing when
 * this booking has moved on from Inquiry, or has no other stay there.
 */
export function useTripAtInquiry(entry: EntryDetail | null) {
  const { session } = useSession();
  const live = (entry?.inquiry?.entries ?? []).filter((s) => s.status === "ACTIVE" || s.status === "PARKED");
  const atInquiry = entry?.currentStage === "S1" ? live.filter((s) => s.currentStage === "S1") : [];
  const otherIds = atInquiry.filter((s) => s.id !== entry?.id).map((s) => s.id);
  const reads = useQueries({
    queries: otherIds.map((id) => ({
      queryKey: ["entry", id],
      queryFn: () => getEntry(session!, id),
      enabled: !!session,
      refetchInterval: 30_000,
    })),
  });
  const others = reads.map((r) => r.data).filter((x): x is EntryDetail => !!x);
  const stayNoOf = (id: string) => live.findIndex((s) => s.id === id) + 1;
  return {
    /** Two stays or more at Inquiry, worked on this one page. */
    combined: otherIds.length > 0,
    otherIds,
    /** The other stays read in full, in the order the trip has them. */
    others: [...others].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id)),
    loaded: others.length === otherIds.length,
    stayNoOf,
  };
}
