"use client";

/**
 * A step reached, said in the middle of the screen (2026-10-27, operator: "after Confirm and move
 * to Negotiation, show something in the middle of the screen that tells the user the inquiry has
 * been made and is moving to Negotiation — the pop-up in the top right corner is easy to miss").
 *
 * A card over a dim scrim at the desk's root: a green tick, what happened, the step it went from
 * and the one it is at now, the booking, what comes next. It closes on Go on, Escape, a click
 * outside it, or by itself after a few seconds — the bar under the button runs down meanwhile. It
 * never moves the page.
 */
import { useEffect, useRef } from "react";
import { Button } from "@/design-system";
import { Overlay } from "@/components/ds/steps/kit";

export type StepMovedNote = {
  title: string;
  /** The step it went from and the one it is at — left out for a note that is not a step move
   *  (the rooms blocked, 2026-10-28). */
  from?: string;
  to?: string;
  /** Who and which booking, under the title. */
  who?: string;
  /** What the desk does next, one short line. */
  next?: string;
};

const SHOW_MS = 6000;

export function StepMoved({ note, onClose }: { note: StepMovedNote | null; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(onClose, SHOW_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => cardRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }));
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [note, onClose]);
  if (!note) return null;
  return (
    <Overlay>
      <div className="step-moved-scrim" onClick={onClose}>
        <div ref={cardRef} className="step-moved" role="status" aria-live="assertive" onClick={(e) => e.stopPropagation()}>
          <span className="sm-mark" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <h2>{note.title}</h2>
          {note.from && note.to ? (
            <div className="sm-path">
              <span className="sm-from">{note.from} ✓</span>
              <span aria-hidden>→</span>
              <span className="sm-to">now at {note.to}</span>
            </div>
          ) : null}
          {note.who ? <p className="sm-who">{note.who}</p> : null}
          {note.next ? <p className="sm-next">{note.next}</p> : null}
          <div className="sm-bar" aria-hidden>
            <i style={{ animationDuration: `${SHOW_MS}ms` }} />
          </div>
          <Button className="go" onClick={onClose}>
            Go on
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
