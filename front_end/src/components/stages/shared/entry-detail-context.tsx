"use client";

import { createContext, useContext } from "react";
import type { EntryDetail } from "@/types/api";

type EntryDetailContextValue = {
  entry: EntryDetail;
  isFetching: boolean;
};

const EntryDetailContext = createContext<EntryDetailContextValue | null>(null);

export function EntryDetailProvider({
  entry,
  isFetching,
  children,
}: EntryDetailContextValue & { children: React.ReactNode }) {
  return <EntryDetailContext.Provider value={{ entry, isFetching }}>{children}</EntryDetailContext.Provider>;
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
