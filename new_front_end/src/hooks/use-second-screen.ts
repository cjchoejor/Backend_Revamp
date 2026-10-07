"use client";

import { useSyncExternalStore } from "react";
import { linkConnected, onLinkChange } from "@/lib/ds/second-screen/link";

/** True while the other screen (the board, seen from the desk — or the desk, from the board) is open. */
export function useSecondScreen(): { connected: boolean } {
  const connected = useSyncExternalStore(onLinkChange, linkConnected, () => false);
  return { connected };
}
