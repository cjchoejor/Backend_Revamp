"use client";

import { useSyncExternalStore } from "react";
import { linkConnected, onLinkChange } from "@/lib/ds/second-screen/link";

/** True while the other screen (the board, seen from the desk — or the desk, from the board) is open. */
export function useSecondScreen(): { connected: boolean } {
  const connected = useSyncExternalStore(onLinkChange, linkConnected, () => false);
  return { connected };
}

/* ---- "Show everything here too" — the desk's way back to the full page while a board is open ---- */

const KEY = "desk:show-everything";
const listeners = new Set<() => void>();
let showEverything = (() => {
  try {
    return typeof window !== "undefined" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

function setShowEverything(v: boolean) {
  showEverything = v;
  try {
    if (v) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* the choice just won't survive a reload */
  }
  for (const fn of listeners) fn();
}

function subscribeShow(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Whether the desk sheds what the second screen already shows (2026-10-07). Only while a board is
 * open: a desk with one monitor keeps everything. `quiet` is false when the operator asked to see
 * everything here too.
 */
export function useDeskQuiet(): { quiet: boolean; connected: boolean; showEverything: boolean; setShowEverything: (v: boolean) => void } {
  const { connected } = useSecondScreen();
  const show = useSyncExternalStore(subscribeShow, () => showEverything, () => false);
  return { quiet: connected && !show, connected, showEverything: show, setShowEverything };
}
