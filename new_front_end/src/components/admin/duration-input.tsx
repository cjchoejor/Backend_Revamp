"use client";

/**
 * A length of time in days, hours and minutes (2026-11-02, operator: "make it into minutes and hrs
 * and days so user doesn't have to calculate it into seconds"). The value stays in whatever unit the
 * setting is stored in; only the boxes are in words a person thinks in. Nothing is rounded away: a
 * stored figure that does not fall on a whole minute keeps a seconds box.
 */
import { useEffect, useRef, useState } from "react";

export type DurationBase = "seconds" | "minutes" | "hours" | "days";
export type DurationUnit = "days" | "hours" | "minutes" | "seconds";

const IN_SECONDS: Record<DurationUnit, number> = { days: 86400, hours: 3600, minutes: 60, seconds: 1 };
const WORD: Record<DurationUnit, [string, string]> = {
  days: ["day", "days"],
  hours: ["hour", "hours"],
  minutes: ["minute", "minutes"],
  seconds: ["second", "seconds"],
};
const SHORT: Record<DurationUnit, string> = { days: "d", hours: "h", minutes: "m", seconds: "s" };

/** The boxes a setting shows when it does not say: nothing finer than the unit it is stored in. */
export function defaultUnits(base: DurationBase): DurationUnit[] {
  if (base === "days") return ["days"];
  if (base === "hours") return ["days", "hours"];
  return ["days", "hours", "minutes"];
}

function split(totalSeconds: number, units: DurationUnit[]): Record<DurationUnit, number> {
  const out: Record<DurationUnit, number> = { days: 0, hours: 0, minutes: 0, seconds: 0 };
  let rest = Math.max(0, Math.round(totalSeconds));
  for (const u of units) {
    out[u] = Math.floor(rest / IN_SECONDS[u]);
    rest -= out[u] * IN_SECONDS[u];
  }
  return out;
}

/** A length of time in words: "1 hour 30 minutes". */
export function durationInWords(value: unknown, base: DurationBase): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const total = Math.round(n * IN_SECONDS[base]);
  if (total === 0) return "None";
  const units: DurationUnit[] = total % 60 ? ["days", "hours", "minutes", "seconds"] : ["days", "hours", "minutes"];
  const parts = split(total, units);
  return units
    .filter((u) => parts[u] > 0)
    .map((u) => `${parts[u]} ${WORD[u][parts[u] === 1 ? 0 : 1]}`)
    .join(" ");
}

export function DurationInput({
  value,
  base,
  units,
  onChange,
  disabled,
  compact,
  invalid,
  "aria-label": ariaLabel,
}: {
  value: unknown;
  base: DurationBase;
  /** Which boxes to offer, largest first. */
  units?: DurationUnit[];
  onChange: (next: number) => void;
  disabled?: boolean;
  /** Short labels and narrow boxes, for a table cell. */
  compact?: boolean;
  invalid?: boolean;
  "aria-label"?: string;
}) {
  const stored = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const totalSeconds = Math.round(stored * IN_SECONDS[base]);

  const wanted = units ?? defaultUnits(base);
  // A figure finer than the smallest box keeps a box of its own, so saving never changes it by accident.
  const smallest = IN_SECONDS[wanted[wanted.length - 1]];
  const shown: DurationUnit[] = totalSeconds % smallest === 0 ? wanted : [...wanted.filter((u) => u !== "seconds"), "seconds"];

  const [drafts, setDrafts] = useState<Partial<Record<DurationUnit, string>>>({});
  const lastEmitted = useRef<number>(totalSeconds);
  const editing = useRef(false);

  // A value changed from outside (a re-read, Undo) replaces whatever the boxes were holding.
  useEffect(() => {
    if (totalSeconds !== lastEmitted.current) {
      lastEmitted.current = totalSeconds;
      setDrafts({});
    }
  }, [totalSeconds]);

  const parts = split(totalSeconds, shown);
  const textOf = (u: DurationUnit) => drafts[u] ?? String(parts[u]);

  const type = (u: DurationUnit, text: string) => {
    if (!/^\d*$/.test(text)) return;
    const next = { ...drafts, [u]: text };
    setDrafts(next);
    let total = 0;
    for (const s of shown) {
      const raw = s === u ? text : next[s] ?? String(parts[s]);
      total += (raw === "" ? 0 : Number.parseInt(raw, 10)) * IN_SECONDS[s];
    }
    lastEmitted.current = total;
    onChange(total / IN_SECONDS[base]);
  };

  return (
    <span className={`dur${compact ? " compact" : ""}${invalid ? " invalid" : ""}`} role="group" aria-label={ariaLabel}>
      {shown.map((u) => (
        <label key={u} className="dur-box">
          <input
            inputMode="numeric"
            value={textOf(u)}
            disabled={disabled}
            aria-label={`${ariaLabel ? `${ariaLabel}, ` : ""}${WORD[u][1]}`}
            onFocus={(e) => {
              editing.current = true;
              e.target.select();
            }}
            onChange={(e) => type(u, e.target.value)}
            // On leaving, 90 minutes reads 1 hour 30 minutes.
            onBlur={() => {
              editing.current = false;
              setDrafts({});
            }}
          />
          <span>{compact ? SHORT[u] : WORD[u][parts[u] === 1 && drafts[u] === undefined ? 0 : 1]}</span>
        </label>
      ))}
    </span>
  );
}
