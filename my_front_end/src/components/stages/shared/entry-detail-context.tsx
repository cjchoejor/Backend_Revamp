"use client";

import { createContext, useContext, useMemo } from "react";
import type { EntryDetail, Stage } from "@/types/api";

type EntryDetailContextValue = {
  entry: EntryDetail;
  isFetching: boolean;
  /** The stage the user is currently viewing (from the URL slug). May differ from entry.currentStage. */
  viewingStage: Stage;
  /** True when viewing a stage that is NOT the entry's current stage — UI should render read-only. */
  isReadOnly: boolean;
};

const EntryDetailContext = createContext<EntryDetailContextValue | null>(null);

export function EntryDetailProvider({
  entry,
  isFetching,
  viewingStage,
  children,
}: { entry: EntryDetail; isFetching: boolean; viewingStage: Stage; children: React.ReactNode }) {
  const value = useMemo<EntryDetailContextValue>(
    () => ({ entry, isFetching, viewingStage, isReadOnly: entry.currentStage !== viewingStage }),
    [entry, isFetching, viewingStage],
  );
  return <EntryDetailContext.Provider value={value}>{children}</EntryDetailContext.Provider>;
}

export function useEntryDetail() {
  const ctx = useContext(EntryDetailContext);
  if (!ctx) {
    throw new Error("useEntryDetail must be used within EntryWorkspace");
  }
  return ctx;
}

export function useEntryDetailOptional() {
  return useContext(EntryDetailContext);
}
