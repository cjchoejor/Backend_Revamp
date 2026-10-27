"use client";

/**
 * The stage-template layout's fixed parts (2026-10-27): the head at the top and the bar at the
 * foot are measured onto the screen as CSS variables, so the booking file between them can use
 * every pixel left; and the head shrinks to its compact form once the page is scrolled, as the
 * operator's template does, so the file gets more of the screen while the work is under way.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** A callback ref that writes the element's height onto the nearest `.ws` as `name`. */
export function useMeasuredVar(name: string) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      const ws = el.closest<HTMLElement>(".ws");
      if (!ws) return;
      const apply = () => ws.style.setProperty(name, `${el.offsetHeight}px`);
      apply();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(apply);
      ro.observe(el);
      observer.current = ro;
    },
    [name],
  );
}

/**
 * Whether the head is compact: on once the page has scrolled past 160px, off again only above
 * 40px, so the head's own shrinking (about 80px) can never flip it back and forth.
 */
export function useCompactOnScroll(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const read = () => setCompact((c) => (window.scrollY > 160 ? true : window.scrollY < 40 ? false : c));
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);
  return compact;
}
