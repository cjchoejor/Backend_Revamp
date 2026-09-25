/**
 * How dates, times and money read on every screen (DSS §8, amended 11 Sep 2026).
 *
 *  - Dates `20 Oct 2026`; ranges `20 → 23 Oct 2026`; day headers `20 Oct`. Never dd/mm/yyyy on
 *    screen — digits transpose, letters do not.
 *  - Times 12-hour with AM/PM, hotel time.
 *  - Money `Nu.1,828.47` — the prefix without a space, international grouping, always two
 *    decimals. A missing figure is a dash. This module formats; it never adds anything up
 *    (FIG 2.1).
 *
 * Stay dates (check-in, check-out, charge dates, night-audit dates) are stored at UTC midnight
 * and name a calendar day, so they are read straight off the ISO string — never shifted through a
 * time zone. Instants (when something happened, when a timer fires) are shown on the hotel's
 * clock (`HOTEL_TZ`, Asia/Thimphu unless the server says otherwise).
 */

export const HOTEL_TZ_DEFAULT = "Asia/Thimphu";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type YMD = { y: number; m: number; d: number };

/** The calendar day an ISO value names (a stay date) — no time zone involved. */
export function ymdOf(value?: string | null): YMD | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** `20 Oct 2026` for a stay date; a dash when absent. */
export function fmtDate(value?: string | null, dash = "—"): string {
  const p = ymdOf(value);
  return p ? `${p.d} ${MON[p.m - 1]} ${p.y}` : dash;
}

/** `20 Oct` — a day header, or a date where the year is obvious. */
export function fmtDay(value?: string | null, dash = "—"): string {
  const p = ymdOf(value);
  return p ? `${p.d} ${MON[p.m - 1]}` : dash;
}

/**
 * `20 → 23 Oct 2026`, `28 Oct → 2 Nov 2026`, `30 Dec 2026 → 2 Jan 2027`.
 * A missing end reads `20 Oct 2026 → —`.
 */
export function fmtRange(from?: string | null, to?: string | null): string {
  const a = ymdOf(from);
  const b = ymdOf(to);
  if (!a && !b) return "—";
  if (a && !b) return `${fmtDate(from)} → —`;
  if (!a && b) return `— → ${fmtDate(to)}`;
  if (a!.y !== b!.y) return `${fmtDate(from)} → ${fmtDate(to)}`;
  if (a!.m !== b!.m) return `${a!.d} ${MON[a!.m - 1]} → ${b!.d} ${MON[b!.m - 1]} ${b!.y}`;
  return `${a!.d} → ${b!.d} ${MON[b!.m - 1]} ${b!.y}`;
}

/** Nights between two stay dates — calendar arithmetic, not money. Null when unknown. */
export function nightsOf(from?: string | null, to?: string | null): number | null {
  const a = ymdOf(from);
  const b = ymdOf(to);
  if (!a || !b) return null;
  const n = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  return n > 0 ? n : null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function partsIn(instant: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(instant)) o[p.type] = p.value;
  const hour = Number(o.hour) % 24;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hour, minute: Number(o.minute), weekday: o.weekday };
}

function toDate(value?: string | number | Date | null): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `2:32 PM` on the hotel's clock. */
export function fmtTime(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT, dash = "—"): string {
  const d = toDate(value);
  if (!d) return dash;
  const p = partsIn(d, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** `20 Oct 2026` for an instant, on the hotel's calendar. */
export function fmtInstantDate(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT, dash = "—"): string {
  const d = toDate(value);
  if (!d) return dash;
  const p = partsIn(d, tz);
  return `${p.d} ${MON[p.m - 1]} ${p.y}`;
}

/** `20 Oct` for an instant, on the hotel's calendar. */
export function fmtInstantDay(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT, dash = "—"): string {
  const d = toDate(value);
  if (!d) return dash;
  const p = partsIn(d, tz);
  return `${p.d} ${MON[p.m - 1]}`;
}

/** `2026-10-20` — the hotel's calendar day an instant falls on (for comparing with stay dates). */
export function instantYmd(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT): string | null {
  const d = toDate(value);
  if (!d) return null;
  const p = partsIn(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** `20 Oct 2026, 5:00 PM` — an end time, a deadline. */
export function fmtDateTime(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT, dash = "—"): string {
  const d = toDate(value);
  if (!d) return dash;
  return `${fmtInstantDate(d, tz)}, ${fmtTime(d, tz)}`;
}

/** `20 Oct 5:00 PM` — a short stamp for history lines and the side panel. */
export function fmtStamp(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT, dash = "—"): string {
  const d = toDate(value);
  if (!d) return dash;
  return `${fmtInstantDay(d, tz)} ${fmtTime(d, tz)}`;
}

/**
 * An instant as the hotel's clock reads it, in the shapes a form takes: `2026-09-26` and `18:00`
 * (2026-09-25). `clockParts` beside it is for DISPLAY — its strings are words, not field values,
 * and putting them in a date input silently empties it.
 */
export function hotelFormParts(value?: string | number | Date | null, tz = HOTEL_TZ_DEFAULT): { date: string; time: string } {
  const d = toDate(value) ?? new Date();
  const p = partsIn(d, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** `Sat 12 Sep 2026` and `2:32 PM` — the clock in the bar. */
export function clockParts(value: string | number | Date, tz = HOTEL_TZ_DEFAULT): { date: string; time: string } {
  const d = toDate(value) ?? new Date();
  const p = partsIn(d, tz);
  return { date: `${p.weekday} ${p.d} ${MON[p.m - 1]} ${p.y}`, time: fmtTime(d, tz) };
}

/** `Saturday 12 September 2026` — the date written out, for page titles. */
export function fmtLongDate(value?: string | null): string {
  const p = ymdOf(value);
  if (!p) return "—";
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const day = dt.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const month = dt.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${day} ${p.d} ${month} ${p.y}`;
}

/** `Sat` — the weekday of a stay date. */
export function weekdayOf(value?: string | null): string {
  const p = ymdOf(value);
  if (!p) return "";
  return DOW[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
}

/**
 * `Nu.1,828.47` — money as the API returned it. Accepts the backend's Decimal strings and plain
 * numbers; formats only (grouping and two places). Null, undefined or a non-number reads as a
 * dash, never as zero (FIG 2.2).
 */
export function money(value: string | number | null | undefined, currency = "BTN", dash = "—"): string {
  if (value === null || value === undefined || value === "") return dash;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return dash;
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = currency === "BTN" || currency === "Nu" || currency === "Nu." ? "Nu." : `${currency} `;
  return n < 0 ? `– ${prefix}${abs}` : `${prefix}${abs}`;
}

/** A span of time in words for dwell and countdowns: `18 min`, `2h 10m`, `3 days`. */
export function span(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return plural(days, "day");
}
