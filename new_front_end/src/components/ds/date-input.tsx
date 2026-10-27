"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { CalendarDays } from "lucide-react";

/**
 * The desk's date box — typed and shown DD/MM/YYYY on every terminal (2026-10-27, operator: "make
 * the date format DD/MM/YYYY, make all the date formats in the system that way").
 *
 * A bare `<input type="date">` draws in the BROWSER's order, so one terminal read 10/27/2026 and
 * the next 27/10/2026. This box types DD/MM/YYYY (the slashes go in as the desk keys digits) and
 * keeps the browser's own calendar behind the button at its end, so picking from a calendar still
 * works — the calendar never shows its own text.
 *
 * A drop-in for the native box: `value` is ISO (YYYY-MM-DD) and `onChange` receives
 * `{ target: { value } }` with ISO, as the native one did — only ever a whole, real date, or ""
 * when the box is emptied. Half a date is kept on screen and goes nowhere; on leaving the box it
 * goes back to the last whole date. A date before `min` or after `max` is pulled to it.
 */

type ChangeLike = { target: { value: string } };

export type DateInputProps = {
  value: string | null | undefined;
  onChange?: (e: ChangeLike) => void;
  /** Called after the box has tidied itself on leaving (a half date back, a date pulled in). */
  onBlur?: () => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  title?: string;
  required?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
};

/** ISO (YYYY-MM-DD…) → "DD/MM/YYYY"; "" when unset or not a date. */
export function isoToDmy(iso?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "DD/MM/YYYY" → ISO; "" when incomplete or not a real calendar day (31/02 is not). */
export function dmyToIso(dmy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy.trim());
  if (!m) return "";
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || y < 1000) return "";
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** The slashes go in as the desk types, so only digits are ever keyed. */
function mask(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("/");
}

export function DateInput({
  value,
  onChange,
  min,
  max,
  disabled,
  readOnly,
  className,
  style,
  id,
  title,
  required,
  autoFocus,
  "aria-label": ariaLabel,
  onBlur,
}: DateInputProps) {
  const iso = (value ?? "").slice(0, 10);
  const [text, setText] = useState(() => isoToDmy(iso));
  // Follow the value when it moves from outside (a default, a check-out following the nights).
  useEffect(() => {
    setText(isoToDmy(iso));
  }, [iso]);

  const emit = (v: string) => onChange?.({ target: { value: v } });
  const clamp = (v: string) => (min && v < min ? min : max && v > max ? max : v);

  const typed = (raw: string) => {
    const next = mask(raw);
    setText(next);
    if (next === "") {
      emit("");
      return;
    }
    const whole = dmyToIso(next);
    // A whole date inside the bounds goes up at once; one outside waits for the blur to be pulled in.
    if (whole && whole === clamp(whole)) emit(whole);
  };
  const left = () => {
    const whole = dmyToIso(text);
    if (!whole) {
      setText(isoToDmy(iso));
      return;
    }
    const v = clamp(whole);
    setText(isoToDmy(v));
    if (v !== iso) emit(v);
  };
  const leave = () => {
    left();
    onBlur?.();
  };
  const inert = disabled || readOnly;

  return (
    // Block-level and full width, as the native box drew under `.input`; a narrow place sizes
    // `.date-input` in CSS (the chart's From / To).
    <span className="date-input" style={{ position: "relative", display: "flex", minWidth: 0 }}>
      <input
        id={id}
        className={className}
        style={{ flex: 1, minWidth: 0, paddingRight: 34, ...style }}
        inputMode="numeric"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        title={title}
        required={required}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={(e) => typed(e.target.value)}
        onBlur={leave}
      />
      <span
        title="Pick from a calendar"
        style={{
          position: "absolute",
          right: 1,
          top: 1,
          bottom: 1,
          width: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: inert ? "none" : "auto",
          opacity: inert ? 0.45 : 1,
        }}
      >
        <CalendarDays aria-hidden style={{ width: 16, height: 16, color: "currentColor" }} />
        {/* The browser's own calendar, invisible over the icon: a click opens it, and the day picked
            comes back as ISO. Its own text is never seen. */}
        <input
          type="date"
          value={iso}
          min={min}
          max={max}
          disabled={inert}
          tabIndex={-1}
          aria-label="Pick from a calendar"
          onChange={(e) => e.target.value && emit(clamp(e.target.value))}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", padding: 0, border: "none", background: "transparent" }}
        />
      </span>
    </span>
  );
}

/**
 * A day and a time of day — the DD/MM/YYYY box beside the browser's time box. A drop-in for
 * `<input type="datetime-local">`: `value` is "YYYY-MM-DDTHH:MM", and `onChange` gets that once both
 * halves are in, or "" while either is missing.
 */
export function DateTimeInput({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
  style,
  "aria-label": ariaLabel,
}: Omit<DateInputProps, "readOnly" | "required" | "autoFocus" | "id" | "title" | "onBlur">) {
  const [date, setDate] = useState((value ?? "").slice(0, 10));
  const [time, setTime] = useState((value ?? "").slice(11, 16));
  useEffect(() => {
    if (!value) return;
    setDate(value.slice(0, 10));
    setTime(value.slice(11, 16));
  }, [value]);
  const emit = (d: string, t: string) => onChange?.({ target: { value: d && t ? `${d}T${t}` : "" } });
  return (
    <span style={{ display: "flex", gap: 6, flex: 1, minWidth: 0, ...style }}>
      <DateInput
        className={className}
        value={date}
        min={min?.slice(0, 10)}
        max={max?.slice(0, 10)}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — day` : "Day"}
        onChange={(e) => {
          setDate(e.target.value);
          emit(e.target.value, time);
        }}
      />
      <input
        type="time"
        className={className}
        style={{ flex: "0 0 auto", width: 130 }}
        value={time}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — time` : "Time"}
        onChange={(e) => {
          setTime(e.target.value);
          emit(date, e.target.value);
        }}
      />
    </span>
  );
}
