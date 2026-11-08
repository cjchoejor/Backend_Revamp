"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getEntry, getStaysTogether } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";

export type TripView = "together" | "one";

/** Negotiation's shared table, and from there the trip's papers at Set up and Reserve (2026-11-09). */
const WORKED_TOGETHER: string[] = ["S2", "S3", "S4"];

const VIEW_EVENT = "desk:trip-view";
const keyOf = (inquiryId: string) => `desk:trip-view:${inquiryId}`;

function readView(inquiryId: string | null | undefined): TripView {
  if (!inquiryId || typeof window === "undefined") return "together";
  try {
    return localStorage.getItem(keyOf(inquiryId)) === "one" ? "one" : "together";
  } catch {
    return "together";
  }
}

/** Together or one stay at a time, remembered for this enquiry on this computer. */
export function useTripView(inquiryId: string | null | undefined): [TripView, (v: TripView) => void] {
  const view = useSyncExternalStore(
    (notify) => {
      window.addEventListener(VIEW_EVENT, notify);
      return () => window.removeEventListener(VIEW_EVENT, notify);
    },
    () => readView(inquiryId),
    () => "together" as TripView,
  );
  const setView = useCallback(
    (v: TripView) => {
      if (!inquiryId) return;
      try {
        localStorage.setItem(keyOf(inquiryId), v);
      } catch {
        /* the view just won't be remembered */
      }
      window.dispatchEvent(new Event(VIEW_EVENT));
    },
    [inquiryId],
  );
  return [view, setView];
}

/**
 * The stays set up the same, worked in one table at Negotiation (2026-11-09, operator: "if the user
 * picks same configuration, then in s2 can it show both the stays configuration in the same table").
 * Which stays those are is the server's (`GET /entries/:id/trip/together`). `active` is the table
 * being shown; a stay set up differently is never in it, and `canBeTogether` is false for it.
 */
export function useStaysTogether(entry: EntryDetail | null) {
  const { session } = useSession();
  const many = (entry?.inquiry?.entries ?? []).length > 1;
  const q = useQuery({
    queryKey: ["trip-together", entry?.id, entry?.updatedAt],
    queryFn: () => getStaysTogether(session!, entry!.id),
    enabled: !!session && !!entry && many && WORKED_TOGETHER.includes(entry.currentStage),
  });
  const stayIds = entry && WORKED_TOGETHER.includes(entry.currentStage) ? (q.data?.stayIds ?? []) : [];
  const otherIds = stayIds.filter((id) => id !== entry?.id);
  const reads = useQueries({
    queries: otherIds.map((id) => ({
      queryKey: ["entry", id],
      queryFn: () => getEntry(session!, id),
      enabled: !!session,
      refetchInterval: 30_000,
    })),
  });
  const [view, setView] = useTripView(entry?.inquiry?.id);
  const others = reads.map((r) => r.data).filter((x): x is EntryDetail => !!x);
  const all = entry?.inquiry?.entries ?? [];
  const stayNoOf = (id: string) => all.findIndex((s) => s.id === id) + 1;
  const canBeTogether = stayIds.length > 1;
  const loaded = others.length === otherIds.length;
  return {
    canBeTogether,
    active: canBeTogether && loaded && view === "together",
    view,
    setView,
    stayIds,
    /** The other stays read in full, in the order the trip has them. */
    others: [...others].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id)),
    stayNoOf,
    /** "Stays 1 and 2" */
    label: `Stays ${stayIds
      .map(stayNoOf)
      .sort((a, b) => a - b)
      .join(stayIds.length > 2 ? ", " : " and ")}`,
  };
}
