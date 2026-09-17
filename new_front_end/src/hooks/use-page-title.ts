"use client";

import { useEffect } from "react";

const BASE_TITLE = "LEGPHEL PMS";

/**
 * Name the browser tab after whoever the tab is about.
 *
 * The desk is routinely worked with several bookings open at once, and every tab reading
 * "LEGPHEL PMS" makes them indistinguishable — you have to click through to find the one you
 * want. Passing the guest's name here puts it in the tab strip instead.
 *
 * Pass null/undefined while the name is still loading; the tab keeps the plain app title until
 * there's something real to show, rather than flashing a placeholder. The previous title is
 * restored on unmount so navigating away doesn't leave a stale name behind.
 */
export function usePageTitle(name: string | null | undefined, suffix?: string) {
  useEffect(() => {
    const previous = document.title;
    const trimmed = name?.trim();
    document.title = trimmed
      ? `${trimmed}${suffix ? ` · ${suffix}` : ""} · ${BASE_TITLE}`
      : suffix
        ? `${suffix} · ${BASE_TITLE}`
        : BASE_TITLE;
    return () => {
      document.title = previous;
    };
  }, [name, suffix]);
}
