"use client";

/**
 * Explanations on request (2026-10-12, operator: "showing all the words is overwhelming ... keep
 * the button with few lines and a small question mark icon, where when the user clicks it shows
 * the details"; "the user doesn't know if he should read it or not ... only show the messages in
 * the screen, or else omit").
 *
 * Two pieces:
 *
 * - `Help` — a small "?" that opens the explanation in a box beside it. Click (or Enter) opens
 *   it; a second click, Escape or a click anywhere else closes it. The box is rendered at the
 *   desk's root so no scrolling table or sticky card can clip or cover it.
 * - `QuietScreen` — the switch. Inside it, the shared pieces (`StepCard`, `SeeRow`, `ActionRow`,
 *   the composition table) put their grey explanatory lines behind a "?" and keep only what is a
 *   MESSAGE on screen: a refusal, a shortfall, a state the operator must act on. Outside it they
 *   behave exactly as before.
 *
 * The switch exists because the operator asked to see one screen first (Negotiation) before the
 * rest of the desk follows. Rolling it out is turning it on wider — no component needs a second
 * form.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const QuietCtx = createContext(false);

/** Explanations behind a "?" for everything inside; only messages stay on screen. */
export function QuietScreen({ on = true, children }: { on?: boolean; children: ReactNode }) {
  return <QuietCtx.Provider value={on}>{children}</QuietCtx.Provider>;
}

/** Is this part of the desk showing explanations on request only? */
export function useQuietScreen(): boolean {
  return useContext(QuietCtx);
}

const POP_WIDTH = 320;
const GAP = 8;

/** A small "?" that shows what something is for, when asked. */
export function Help({ children, label = "What is this?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    setHost(document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body);
  }, []);

  // Beside the "?", below it unless the window has no room there — then above it.
  const place = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? 0;
    const w = Math.min(POP_WIDTH, window.innerWidth - 2 * GAP);
    const left = Math.min(Math.max(GAP, r.left - 12), window.innerWidth - w - GAP);
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - GAP && r.top - GAP - h > GAP ? r.top - GAP - h : below;
    // Never off the window: a "?" scrolled under a sticky header still opens a readable box.
    setPos({ top: Math.min(Math.max(GAP, top), Math.max(GAP, window.innerHeight - h - GAP)), left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="help-q"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          // A "?" sits inside cards, table headers and rows that carry clicks of their own.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      {open && host
        ? createPortal(
            <div
              ref={pop}
              id={id}
              role="dialog"
              aria-label={label}
              className="help-pop"
              style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            >
              {children}
            </div>,
            host,
          )
        : null}
    </>
  );
}
