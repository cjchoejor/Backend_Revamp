"use client";

import type { ReactNode } from "react";
import { StageTransitionProvider } from "@/components/stages/shared/stage-transition-context";
import { StageTransitionOverlay } from "@/components/stages/shared/stage-transition-overlay";

/** Persists stage transition overlay across S1–S9 route changes for the same entry. */
export default function EntryIdLayout({ children }: { children: ReactNode }) {
  return (
    <StageTransitionProvider>
      {children}
      <StageTransitionOverlay />
    </StageTransitionProvider>
  );
}
