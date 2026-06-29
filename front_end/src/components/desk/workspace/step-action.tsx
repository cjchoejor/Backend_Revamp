"use client";

import { Check } from "lucide-react";

/**
 * Smooth workspace action button.
 *
 * Why this exists: the per-step action buttons used to (a) swap their label to a
 * "…ing" verb mid-mutation (different width → the button reflows/flickers), and
 * (b) get unmounted and replaced by a separate confirmation box once the action
 * succeeded (so there was no transition — the new state just popped in). This
 * keeps ONE button element mounted across idle → pending → done, so the only
 * thing that changes is its class/label, and the `.btn` CSS transition animates
 * the colour shift to the green `is-done` state (mirrors the smooth S4→S5 feel).
 *
 * - `pending`: action in flight — the button stays the same size (no label swap),
 *   just disables. The calm dim comes from `.btn[disabled]`.
 * - `done`: the action's effect is now true in the data — the button turns green
 *   with a check and shows `doneLabel`. Stays mounted, so the colour animates.
 */
export function StepAction({
  label,
  doneLabel,
  done = false,
  pending = false,
  disabled = false,
  onClick,
  className = "btn btn-ghost btn-sm",
  icon,
}: {
  label: React.ReactNode;
  /** Shown once `done` — defaults to `label`. */
  doneLabel?: React.ReactNode;
  done?: boolean;
  pending?: boolean;
  /** Extra gating (e.g. a required field is empty). `pending`/`done` already disable. */
  disabled?: boolean;
  onClick?: () => void;
  /** Defaults to `btn btn-ghost btn-sm`; pass `btn btn-primary` for the primary action. */
  className?: string;
  /** Optional leading icon shown while not done (the check replaces it when done). */
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${className}${done ? " is-done" : ""}`}
      disabled={disabled || pending || done}
      aria-busy={pending || undefined}
      onClick={onClick}
    >
      {done ? <Check /> : icon}
      <span>{done ? doneLabel ?? label : label}</span>
    </button>
  );
}
