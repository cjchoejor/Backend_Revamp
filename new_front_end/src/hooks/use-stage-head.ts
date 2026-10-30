"use client";

/**
 * The stage-template layout's fixed parts (2026-10-27): the head at the top and the bar at the
 * foot are measured onto the screen as CSS variables, so a card scrolled to lands between them.
 * The head no longer shrinks on scroll (2026-10-27, operator: "we remove the minimizing of the top
 * bars") — the stay's facts moved to the booking file's head, on the right.
 */

import { useCallback, useRef } from "react";

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

