"use client";

import { useEffect } from "react";

const CONTROLS = "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])";
const TOP_BAR = 52;

function showable(el: Element) {
  return (el as HTMLElement).offsetParent !== null;
}

/** The form this button fills, when it is already on the page: the closest one above the button. */
function nearestForm(button: Element): Element | null {
  let scope = button.parentElement;
  while (scope) {
    const form = scope.querySelector("[data-edit-form]");
    if (form) return form;
    scope = scope.parentElement;
  }
  return null;
}

function goTo(el: Element) {
  const box = el.getBoundingClientRect();
  const top = TOP_BAR + 8;
  // Already all on screen: nothing to go to.
  if (box.top < top || box.bottom > window.innerHeight - 8) {
    (el as HTMLElement).style.scrollMarginTop = `${top + 8}px`;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: box.height > window.innerHeight - top ? "start" : "center" });
  }
  const first = el.matches(CONTROLS) ? el : el.querySelector(CONTROLS);
  (first as HTMLElement | null)?.focus({ preventScroll: true });
}

/**
 * An Edit or Change anywhere in the console goes to the fields it opens (2026-11-03, operator: "when
 * user clicks edit in any place in admin console, it opens the edit fields below but also
 * automatically take the user to that section"). Whatever the press adds to the page is what it
 * opened; a form that is always on the page says so with `data-edit-form`.
 */
export function useGoToWhatEditOpens() {
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const button = (ev.target as Element | null)?.closest?.("button");
      const main = button?.closest(".admin-main");
      if (!button || !main) return;
      if (!/^(Edit|Change)\b/.test((button.textContent ?? "").trim())) return;
      const added: Element[] = [];
      const watch = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof Element && (n.matches(CONTROLS) || n.querySelector(CONTROLS))) added.push(n);
          }
        }
      });
      watch.observe(main, { childList: true, subtree: true });
      window.setTimeout(() => {
        watch.disconnect();
        const opened = added.find((n) => n.isConnected && showable(n)) ?? nearestForm(button);
        if (opened && showable(opened)) goTo(opened);
      }, 160);
    };
    // Capture: this has to read the button and start watching before React changes the page.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
