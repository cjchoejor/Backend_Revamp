"use client";

/**
 * A button that is waiting on the server says so (2026-10-14, operator: "when I click on Reserve, or
 * send for papers, or switch — any button which takes time to do its job — show a loading icon").
 *
 * One watcher for the whole app instead of a flag on every button: the button pressed is noted, and
 * a request to `/api/` that starts within a moment of the press belongs to it. While its requests
 * run, the button carries `data-pending` (a spinning ring before its label, `globals.css`) and
 * `aria-busy`, and takes no second press — so a slow walk can no longer be sent twice. A request
 * that follows a finished one within a breath (an `await a; await b` chain, the refresh after a
 * save) carries on the same button, so the ring does not blink off between steps.
 *
 * A press that only opens a dialog or switches a tab sends nothing and gets no ring. Attributes, not
 * classes: React rewrites `className` on its next render, but leaves an attribute it does not own.
 * A button that should never show it carries `data-no-pending` (on itself or an ancestor).
 */
import { useEffect } from "react";

/** A request this soon after a press belongs to it. */
const PRESS_WINDOW_MS = 700;
/** A request starting this soon after the button's last one ended carries on (a chain of steps). */
const CHAIN_GRACE_MS = 250;

type Track = { el: HTMLElement; inFlight: number; clearTimer: number | null };

export function PendingButtons() {
  useEffect(() => {
    const w = window as Window & { __deskPendingButtons?: boolean };
    if (w.__deskPendingButtons) return;
    w.__deskPendingButtons = true;

    let lastPress: { el: HTMLElement; at: number } | null = null;
    const tracks = new Map<HTMLElement, Track>();
    let chaining: Track | null = null;

    const onPress = (e: Event) => {
      const target = e.target as Element | null;
      const el = target?.closest?.("button, [role='button'], input[type='submit']") as HTMLElement | null;
      if (!el || el.closest("[data-no-pending]")) return;
      lastPress = { el, at: performance.now() };
    };
    // A press, or Enter / Space on a focused button — both arrive as a click.
    document.addEventListener("click", onPress, true);

    const begin = (el: HTMLElement): Track => {
      let tr = tracks.get(el);
      if (!tr) {
        tr = { el, inFlight: 0, clearTimer: null };
        tracks.set(el, tr);
      }
      if (tr.clearTimer !== null) {
        window.clearTimeout(tr.clearTimer);
        tr.clearTimer = null;
      }
      tr.inFlight += 1;
      el.setAttribute("data-pending", "");
      el.setAttribute("aria-busy", "true");
      return tr;
    };
    const finish = (tr: Track) => {
      tr.inFlight = Math.max(0, tr.inFlight - 1);
      if (tr.inFlight > 0) return;
      chaining = tr;
      tr.clearTimer = window.setTimeout(() => {
        tr.el.removeAttribute("data-pending");
        tr.el.removeAttribute("aria-busy");
        tracks.delete(tr.el);
        if (chaining === tr) chaining = null;
      }, CHAIN_GRACE_MS);
    };

    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let tr: Track | null = null;
      if (url.includes("/api/")) {
        const now = performance.now();
        if (lastPress && now - lastPress.at < PRESS_WINDOW_MS && lastPress.el.isConnected) tr = begin(lastPress.el);
        else if (chaining && chaining.clearTimer !== null && chaining.el.isConnected) tr = begin(chaining.el);
      }
      const request = original(input, init);
      if (!tr) return request;
      const t = tr;
      return request.finally(() => finish(t));
    };
  }, []);
  return null;
}
