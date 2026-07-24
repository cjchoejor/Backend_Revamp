"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";

/**
 * A date field that reads and writes **dd/mm/yyyy**, which is how the desk writes dates.
 *
 * A bare `<input type="date">` renders in the *browser's* locale, so the same booking shows
 * 07/22/2026 on one terminal and 22/07/2026 on the next. This types as dd/mm/yyyy everywhere,
 * while keeping a real date input behind the calendar button so the native picker still works.
 *
 * `value` / `onChange` stay on ISO (yyyy-mm-dd) — the shape the API and every caller already use.
 */

/** ISO (yyyy-mm-dd) → "dd/mm/yyyy". "" when unset or unparseable. */
export function isoToDmy(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "dd/mm/yyyy" → ISO (yyyy-mm-dd). "" when incomplete or not a real calendar date. */
export function dmyToIso(dmy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy.trim());
  if (!m) return "";
  const [, dd, mm, yyyy] = m;
  const d = Number(dd);
  const mo = Number(mm);
  const y = Number(yyyy);
  if (mo < 1 || mo > 12 || d < 1 || y < 1000) return "";
  // Reject the 31sts of 30-day months and bad leap days rather than letting Date roll them over.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return "";
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The day after an ISO date — the earliest legal check-out for a given check-in, since a stay is
 * at least one night. "" when the input is unset. UTC arithmetic so it can't skip or repeat a day.
 */
export function nextDayIso(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return d.toISOString().slice(0, 10);
}

/** Insert the slashes as the operator types, so they only ever key digits. */
function mask(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter((p) => p !== "");
  return parts.join("/");
}

export function DateField({
  value,
  onChange,
  min,
  disabled,
  id,
}: {
  /** ISO yyyy-mm-dd, or "" when unset. */
  value: string;
  /** Called with ISO yyyy-mm-dd (or "" when the field is cleared). */
  onChange: (iso: string) => void;
  /** Earliest allowed date, ISO. Enforced on blur as well as in the native picker. */
  min?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [text, setText] = useState(() => isoToDmy(value));
  const pickerRef = useRef<HTMLInputElement>(null);

  // Follow the value when it changes upstream (defaults on mount, check-out auto-syncing to a new
  // check-in). Partial typing never lands here — `value` only moves once a full date parses.
  useEffect(() => {
    setText(isoToDmy(value));
  }, [value]);

  const handleType = (raw: string) => {
    const masked = mask(raw);
    setText(masked);
    if (masked === "") {
      onChange("");
      return;
    }
    const iso = dmyToIso(masked);
    if (iso) onChange(iso);
  };

  // On blur, tidy up: drop a half-typed date, and pull anything before `min` up to `min` — the
  // guarantee the native input's `min` used to give us (e.g. intake can't take a past check-in).
  const handleBlur = () => {
    const iso = dmyToIso(text);
    if (!iso) {
      setText(isoToDmy(value));
      return;
    }
    if (min && iso < min) {
      onChange(min);
      setText(isoToDmy(min));
    }
  };

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <input
        id={id}
        className="dinput"
        style={{ flex: 1, paddingRight: 34 }}
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        maxLength={10}
        value={text}
        disabled={disabled}
        onChange={(e) => handleType(e.target.value)}
        onBlur={handleBlur}
      />
      <span
        title="Pick from a calendar"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: disabled ? "none" : "auto",
        }}
      >
        <CalendarDays style={{ width: 15, height: 15, color: "var(--ink-3)" }} />
        {/* Transparent native date input on top of the icon: clicking it opens the OS picker,
            which writes ISO straight back through onChange. Never shows its own locale text. */}
        <input
          ref={pickerRef}
          type="date"
          value={value}
          min={min}
          disabled={disabled}
          tabIndex={-1}
          aria-label="Open date picker"
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
            padding: 0,
            border: "none",
            background: "transparent",
          }}
        />
      </span>
    </div>
  );
}
