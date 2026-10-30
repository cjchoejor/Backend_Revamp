"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CalendarDays, Clock } from "lucide-react";
import { PickFooter, PickPopover, pickCell, pickColours } from "./pick-popover";

/**
 * The desk's date box — typed and shown DD/MM/YYYY on every terminal (2026-10-27, operator: "make
 * the date format DD/MM/YYYY, make all the date formats in the system that way").
 *
 * A bare `<input type="date">` draws in the BROWSER's order, so one terminal read 10/27/2026 and
 * the next 27/10/2026. This box types DD/MM/YYYY (the slashes go in as the desk keys digits) and
 * keeps a calendar behind the button at its end. The calendar is the desk's own since 2026-10-29
 * (operator: "keep an OK or tick button in the calendar") — a day is picked, then ✓ OK; the
 * browser's calendar had no way out but a press outside it.
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
  const calBtn = useRef<HTMLButtonElement | null>(null);
  const [calOpen, setCalOpen] = useState(false);

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
      <button
        ref={calBtn}
        type="button"
        title="Pick from a calendar"
        aria-label="Pick from a calendar"
        aria-expanded={calOpen}
        tabIndex={-1}
        disabled={inert}
        onClick={() => setCalOpen((o) => !o)}
        style={{
          position: "absolute",
          right: 1,
          top: 1,
          bottom: 1,
          width: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: "currentColor",
          padding: 0,
          cursor: inert ? "default" : "pointer",
          opacity: inert ? 0.45 : 1,
        }}
      >
        <CalendarDays aria-hidden style={{ width: 16, height: 16 }} />
      </button>
      <PickPopover anchor={calBtn} open={calOpen} onCancel={() => setCalOpen(false)} width={292} label="Pick a day">
        <CalendarPick
          value={iso}
          min={min}
          max={max}
          onCancel={() => setCalOpen(false)}
          onPick={(v) => {
            setCalOpen(false);
            emit(clamp(v));
          }}
        />
      </PickPopover>
    </span>
  );
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/** "2026-10-29" → "Thu 29 Oct 2026". */
function dayInWords(iso: string): string {
  const [y, m, d] = iso.split("-").map((x) => Number(x));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

/**
 * The month on screen and the day picked; ✓ OK puts the day in the box, Cancel leaves the box as
 * it was. A double click is a pick and OK in one. Days outside min / max are shut.
 */
function CalendarPick({ value, min, max, onPick, onCancel }: { value: string; min?: string; max?: string; onPick: (iso: string) => void; onCancel: () => void }) {
  // The month it opens on: the box's day, else the first day it allows, else this month on this
  // machine (only which month is shown first — nothing is picked from it).
  const opening = value || min || (() => { const n = new Date(); return isoOf(n.getFullYear(), n.getMonth() + 1, n.getDate()); })();
  const [ym, setYm] = useState(() => opening.slice(0, 7));
  const [draft, setDraft] = useState(value);
  const [y, m] = ym.split("-").map((x) => Number(x));
  const shift = (by: number) => {
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setYm(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  };
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, k) => {
    const d = new Date(Date.UTC(y, m - 1, 1 - lead + k));
    return { iso: isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === m - 1 };
  });
  const shut = (iso: string) => (!!min && iso < min) || (!!max && iso > max);
  const navBtn: CSSProperties = { width: 30, height: 30, border: `1px solid ${pickColours.line2}`, borderRadius: 4, background: pickColours.surface, color: pickColours.ink, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 };
  const canOk = !!draft && !shut(draft);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <button type="button" style={navBtn} aria-label="The month before" onClick={() => shift(-1)}>‹</button>
        <b style={{ flex: 1, textAlign: "center", fontSize: 14 }}>{MONTH_NAMES[m - 1]} {y}</b>
        <button type="button" style={navBtn} aria-label="The month after" onClick={() => shift(1)}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }} role="grid" aria-label={`${MONTH_NAMES[m - 1]} ${y}`}>
        {WEEKDAYS.map((w) => (
          <span key={w} style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: pickColours.muted, paddingBottom: 2 }}>{w}</span>
        ))}
        {cells.map((c) => {
          const off = shut(c.iso);
          const on = c.iso === draft;
          return (
            <button
              key={c.iso}
              type="button"
              data-day={c.iso}
              aria-pressed={on}
              aria-label={dayInWords(c.iso)}
              disabled={off}
              onClick={() => setDraft(c.iso)}
              onDoubleClick={() => !off && onPick(c.iso)}
              style={pickCell(on, off, { opacity: c.inMonth || on ? 1 : 0.5 })}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      <PickFooter picked={draft ? dayInWords(draft) : "Pick a day"} canOk={canOk} onOk={() => canOk && onPick(draft)} onCancel={onCancel} />
    </div>
  );
}

/** "15:05" → "3:05 PM"; "" when not a time. */
export function timeInWords(hhmm?: string | null): string {
  const t = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  if (!t) return "";
  const h = Number(t[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${t[2]} ${h < 12 ? "AM" : "PM"}`;
}

type TimeInputProps = {
  /** "HH:MM", 24-hour; "" when unset. */
  value: string | null | undefined;
  onChange?: (e: ChangeLike) => void;
  /** The earliest and latest times open, "HH:MM" (both included). */
  min?: string;
  max?: string;
  /** The minutes offered, every N (5 by default); the box's own minute is always offered too. */
  minuteStep?: number;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  "aria-label"?: string;
};

/**
 * The desk's time box (2026-10-29, operator: "keep an OK or tick button … in the time when the
 * user is choosing" — the browser's time box opened a list with no way out but a press outside).
 * A press opens the hour, the minutes and AM / PM; ✓ OK puts the time in the box, Cancel or Escape
 * leaves it as it was. Times outside min / max are shut. A drop-in for `<input type="time">`:
 * `value` and `onChange({ target: { value } })` are "HH:MM", 24-hour.
 */
export function TimeInput({ value, onChange, min, max, minuteStep = 5, disabled, className, style, placeholder = "Pick a time", "aria-label": ariaLabel }: TimeInputProps) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const shown = timeInWords(value);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        disabled={disabled}
        aria-label={ariaLabel ?? "Time"}
        aria-expanded={open}
        data-time-input=""
        onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left", cursor: disabled ? "default" : "pointer", minWidth: 0, ...style }}
      >
        <span style={{ color: shown ? undefined : pickColours.muted, whiteSpace: "nowrap" }}>{shown || placeholder}</span>
        <Clock aria-hidden style={{ width: 16, height: 16, flex: "0 0 auto", opacity: disabled ? 0.45 : 0.8 }} />
      </button>
      <PickPopover anchor={btn} open={open} onCancel={() => setOpen(false)} width={318} label="Pick a time">
        <TimePick
          value={value ?? ""}
          min={min}
          max={max}
          minuteStep={minuteStep}
          onCancel={() => setOpen(false)}
          onPick={(v) => {
            setOpen(false);
            onChange?.({ target: { value: v } });
          }}
        />
      </PickPopover>
    </>
  );
}

function TimePick({ value, min, max, minuteStep, onPick, onCancel }: { value: string; min?: string; max?: string; minuteStep: number; onPick: (v: string) => void; onCancel: () => void }) {
  const t = /^(\d{2}):(\d{2})$/.exec(value);
  const [h12, setH12] = useState<number | null>(t ? Number(t[1]) % 12 || 12 : null);
  const [mi, setMi] = useState<number | null>(t ? Number(t[2]) : null);
  const [ap, setAp] = useState<"AM" | "PM" | null>(t ? (Number(t[1]) < 12 ? "AM" : "PM") : null);
  const to24 = (h: number, m: number, a: "AM" | "PM") => `${pad2((h % 12) + (a === "PM" ? 12 : 0))}:${pad2(m)}`;
  const open = (hhmm: string) => (!min || hhmm >= min) && (!max || hhmm <= max);
  const minutes = Array.from(new Set([...Array.from({ length: Math.ceil(60 / minuteStep) }, (_, k) => k * minuteStep), ...(mi != null ? [mi] : [])])).sort((a, b) => a - b);
  const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const aps: Array<"AM" | "PM"> = ap ? [ap] : ["AM", "PM"];
  const hourOpen = (h: number) => aps.some((a) => minutes.some((m) => open(to24(h, m, a))));
  const minuteOpen = (m: number) => aps.some((a) => (h12 != null ? [h12] : hours).some((h) => open(to24(h, m, a))));
  const apOpen = (a: "AM" | "PM") => (h12 != null ? [h12] : hours).some((h) => (mi != null ? [mi] : minutes).some((m) => open(to24(h, m, a))));
  const whole = h12 != null && mi != null && ap != null ? to24(h12, mi, ap) : null;
  const canOk = !!whole && open(whole);
  const head: CSSProperties = { fontSize: 12, fontWeight: 600, color: pickColours.muted, margin: "0 0 4px" };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <p style={head}>Hour</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3 }}>
            {hours.map((h) => {
              const shut = !hourOpen(h);
              return (
                <button key={h} type="button" data-hour={h} aria-pressed={h === h12} disabled={shut} onClick={() => setH12(h)} style={pickCell(h === h12, shut)}>
                  {h}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p style={head}>Minutes</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3 }}>
            {minutes.map((m) => {
              const shut = !minuteOpen(m);
              return (
                <button key={m} type="button" data-minute={m} aria-pressed={m === mi} disabled={shut} onClick={() => setMi(m)} style={pickCell(m === mi, shut)}>
                  :{pad2(m)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
        {(["AM", "PM"] as const).map((a) => {
          const shut = !apOpen(a);
          return (
            <button key={a} type="button" data-ampm={a} aria-pressed={a === ap} disabled={shut} onClick={() => setAp(a)} style={pickCell(a === ap, shut, { border: `1px solid ${a === ap ? pickColours.accent : pickColours.line2}` })}>
              {a}
            </button>
          );
        })}
      </div>
      <PickFooter
        picked={
          whole ? (
            open(whole) ? (
              <b style={{ color: pickColours.ink }}>{timeInWords(whole)}</b>
            ) : (
              <span style={{ color: "var(--danger, #b3261e)", fontWeight: 600 }}>
                {timeInWords(whole)} is not open{min && whole < min ? ` — from ${timeInWords(min)}` : max ? ` — until ${timeInWords(max)}` : ""}
              </span>
            )
          ) : (
            "Pick the hour, minutes and AM or PM"
          )
        }
        canOk={canOk}
        onOk={() => whole && canOk && onPick(whole)}
        onCancel={onCancel}
      />
    </div>
  );
}

/**
 * A day and a time of day — the DD/MM/YYYY box beside the desk's time box. A drop-in for
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
      <TimeInput
        className={className}
        style={{ flex: "0 0 auto", width: 140 }}
        value={time}
        // On the first or last day allowed, the times before or after the bound are shut.
        min={min && date && date === min.slice(0, 10) ? min.slice(11, 16) || undefined : undefined}
        max={max && date && date === max.slice(0, 10) ? max.slice(11, 16) || undefined : undefined}
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
