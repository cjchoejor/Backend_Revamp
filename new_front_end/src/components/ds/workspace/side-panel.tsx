"use client";

/**
 * The side panel, folding to a thin bar (2026-10-23, operator: "can this side be a collapsible
 * feature … collapsed it becomes a thin bar with a circular timer where the outer ring fills in
 * gradually … it also shows the to do here … and the contents in the middle widen when it is
 * collapsed").
 *
 * Open, it is the panel as it was, with a fold button at its head. Folded, it is one button the
 * width of an icon: the soonest clock as a ring (`TimerRing`), how many more clocks run, and the
 * to-do as its numbered circles — ticked when done, the next one outlined. A click anywhere on the
 * bar opens it. The workspace's grid gives the column back to the middle (`.ws-body.side-folded`).
 * The choice is this desk's own (`localStorage`, a per-viewer convenience) and holds across bookings.
 */
import { useState, type ReactNode } from "react";
import { Icon } from "@/design-system";
import type { FlowItem } from "@/components/ds/steps/kit";
import type { TimerRecordSummary } from "@/lib/api/entries";
import { TimerRing } from "./side-timer";

const KEY = "desk:side-folded";

export function useSideFolded(): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* private mode — the panel still folds, it just will not be remembered */
    }
  };
  return [folded, set];
}

export function FoldingSide({
  folded,
  onFold,
  clocks,
  todo,
  also = [],
  children,
}: {
  folded: boolean;
  onFold: (folded: boolean) => void;
  /** The running clocks, soonest first — the first is the ring. */
  clocks: Array<{ t: TimerRecordSummary; label: string }>;
  todo: FlowItem[];
  also?: ReadonlyArray<{ label: string; met: boolean }>;
  children: ReactNode;
}) {
  if (!folded) {
    return (
      <aside className="side" aria-label="Timers and to do">
        <button type="button" className="side-fold" aria-expanded="true" aria-label="Fold the panel" title="Fold the panel" onClick={() => onFold(true)}>
          <Icon name="chev" />
        </button>
        {children}
      </aside>
    );
  }
  const first = clocks[0] ?? null;
  const next = todo.find((i) => !i.met) ?? null;
  const open = todo.filter((i) => !i.met).length + also.filter((p) => !p.met).length;
  return (
    <aside className="side folded" aria-label="Timers and to do, folded">
      <button
        type="button"
        className="side-open"
        aria-expanded="false"
        aria-label={`Open the panel${open ? ` · ${open} still to do` : ""}`}
        title="Open the panel"
        onClick={() => onFold(false)}
      >
        <span className="side-fold-ic">
          <Icon name="chev" className="flip" />
        </span>
        {first ? (
          <TimerRing timer={first.t} label={first.label} />
        ) : (
          <span className="side-ring none" title="Nothing running">
            <Icon name="clock" />
          </span>
        )}
        {clocks.length > 1 ? <span className="side-more">+{clocks.length - 1}</span> : null}
        {todo.length || also.length ? (
          <span className="side-dots">
            {todo.map((i) => (
              <span
                key={`${i.n}-${i.card}-${i.label}`}
                className={`n${i.met ? " done" : ""}${i === next ? " next" : ""}`}
                title={i.label}
              >
                {i.met ? <Icon name="check" /> : i.n}
              </span>
            ))}
            {also.map((p) => (
              <span key={p.label} className={`n${p.met ? " done" : ""}`} title={p.label}>
                {p.met ? <Icon name="check" /> : "!"}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </aside>
  );
}
