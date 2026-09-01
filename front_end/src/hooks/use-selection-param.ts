"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * A master/detail selection that survives a refresh.
 *
 * Every admin page held its selection in plain `useState`, so reloading the page — or following a
 * link back to it — dropped the operator back to "nothing selected". Someone reviewing Bhutan
 * INC's rate packages, hitting refresh, landed on the agent list with no agent chosen and had to
 * find them again.
 *
 * The selection lives in the URL query string instead. That fixes the refresh, and gets two
 * things for free: the browser Back button steps through selections, and the address bar is a
 * shareable link to exactly what is on screen.
 *
 * `router.replace` rather than `push` for the write, so choosing between rows does not stack a
 * history entry per click — Back should leave the page, not walk the list.
 *
 * Falls back to `initial` when the URL carries nothing, so pages that must always have something
 * selected (the config-key pages) keep their default.
 */
export function useSelectionParam(
  key: string,
  initial: string | null = null,
): [string | null, (next: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get(key);

  // Held in state as well as the URL so a caller reading it during the same render that sets it
  // sees the new value; the URL is the durable copy, this is the immediate one.
  const [value, setValue] = useState<string | null>(fromUrl ?? initial);

  // Adopt external URL changes (Back/Forward, or a pasted link).
  useEffect(() => {
    setValue(fromUrl ?? initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl]);

  const set = useCallback(
    (next: string | null) => {
      setValue(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next == null || next === "") params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [key, pathname, router, searchParams],
  );

  return [value, set];
}
