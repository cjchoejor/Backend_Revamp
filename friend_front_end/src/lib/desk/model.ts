/**
 * Front-desk (/desk) view model.
 *
 * The mockup speaks operator language — Inquiry, Quote, Set up, Confirm,
 * Arrival, Check-in, Stay, Check-out, Closed — never stage numbers. This
 * module is the single translation layer between the backend's S1–S9
 * `EntryListItem` data and that operator vocabulary. Keep all stage→step
 * mapping and label/derivation logic here so individual pages stay dumb.
 */
import type { EntryListItem, EntryStatus, GuestProfileName, Stage } from "@/types/api";

export type DeskStepKey =
  | "inquiry"
  | "quote"
  | "setup"
  | "confirm"
  | "arrival"
  | "checkin"
  | "stay"
  | "checkout"
  | "closed";

export type DeskStep = {
  /** 1-based position in the journey (1 = Inquiry … 9 = Closed). */
  order: number;
  key: DeskStepKey;
  /** The backend stage this step corresponds to. */
  stage: Stage;
  label: string;
  /** Sub-caption shown under the label in the journey rail. */
  sub: string;
  /** A commitment boundary — the moment something seals. */
  bound?: boolean;
  /** What the operator should do next while a booking sits at this step. */
  need: string;
};

export const DESK_STEPS: DeskStep[] = [
  { order: 1, key: "inquiry", stage: "S1", label: "Inquiry", sub: "understand the stay", need: "Capture the stay and explore availability" },
  { order: 2, key: "quote", stage: "S2", label: "Quote", sub: "shape the price", need: "Shape the price and send the quote" },
  { order: 3, key: "setup", stage: "S3", label: "Set up", sub: "hold & deposit", need: "Hold the rooms and record the advance" },
  { order: 4, key: "confirm", stage: "S4", label: "Confirm", sub: "freeze the booking", bound: true, need: "Everything's ready — confirm to freeze" },
  { order: 5, key: "arrival", stage: "S5", label: "Arrival", sub: "ready the room", need: "Ready the room for arrival" },
  { order: 6, key: "checkin", stage: "S6", label: "Check-in", sub: "keys & live folio", bound: true, need: "Verify identity and open the live folio" },
  { order: 7, key: "stay", stage: "S7", label: "Stay", sub: "daily charges", need: "Guest in-house — post charges as they happen" },
  { order: 8, key: "checkout", stage: "S8", label: "Check-out", sub: "settle up", need: "Settle the folio and collect the keys" },
  { order: 9, key: "closed", stage: "S9", label: "Closed", sub: "sealed", need: "Sealed — read-only record" },
];

const STAGE_TO_STEP: Record<string, DeskStep> = {
  S1: DESK_STEPS[0],
  S2: DESK_STEPS[1],
  S3: DESK_STEPS[2],
  S4: DESK_STEPS[3],
  S5: DESK_STEPS[4],
  S6: DESK_STEPS[5],
  S7: DESK_STEPS[6],
  S8: DESK_STEPS[7],
  S9: DESK_STEPS[8],
  TERMINAL: DESK_STEPS[8],
};

export function stepForStage(stage: Stage | string | null | undefined): DeskStep {
  return STAGE_TO_STEP[String(stage ?? "S1").toUpperCase()] ?? DESK_STEPS[0];
}

/** Warm avatar palette echoing the mockup's mixed earth tones. */
const AVATAR_COLORS = [
  "#c07d5f",
  "#3c5a45",
  "#8a6d4f",
  "#7a8b5a",
  "#5e8090",
  "#a4634a",
  "#6a7f8c",
  "#54705c",
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function guestName(g?: GuestProfileName | null): string {
  if (!g) return "Guest";
  if (g.displayName?.trim()) return g.displayName.trim();
  const full = [g.firstName, g.lastName].filter(Boolean).join(" ").trim();
  return full || "Guest";
}

export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "G";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12–15 Jul" / "12 Jul – 3 Aug" / "" when no dates. */
export function formatStayRange(checkIn?: string | null, checkOut?: string | null): string {
  const ci = parseDate(checkIn);
  const co = parseDate(checkOut);
  if (!ci && !co) return "";
  if (ci && !co) return `${ci.getDate()} ${MONTHS[ci.getMonth()]}`;
  if (!ci && co) return `→ ${co!.getDate()} ${MONTHS[co!.getMonth()]}`;
  if (ci!.getMonth() === co!.getMonth() && ci!.getFullYear() === co!.getFullYear()) {
    return `${ci!.getDate()}–${co!.getDate()} ${MONTHS[ci!.getMonth()]}`;
  }
  return `${ci!.getDate()} ${MONTHS[ci!.getMonth()]} – ${co!.getDate()} ${MONTHS[co!.getMonth()]}`;
}

/**
 * "22/07/2026" — the desk's canonical written date format (dd/mm/yyyy).
 *
 * Reads the calendar date straight off an ISO string rather than going through `Date`, so a
 * date-only value like "2026-07-22" can't drift a day either way on a machine whose clock is
 * set behind UTC. Falls back to local-time parsing for full timestamps.
 */
export function formatDMY(value?: string | null): string {
  if (!value) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const d = parseDate(value);
  if (!d) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** "22/07/2026 → 25/07/2026" — the explicit form used wherever check-in and check-out are named. */
export function formatStayRangeDMY(checkIn?: string | null, checkOut?: string | null): string {
  const ci = formatDMY(checkIn);
  const co = formatDMY(checkOut);
  if (!ci && !co) return "";
  if (ci && !co) return ci;
  if (!ci && co) return `→ ${co}`;
  return `${ci} → ${co}`;
}

export function nightsBetween(checkIn?: string | null, checkOut?: string | null): number | null {
  const ci = parseDate(checkIn);
  const co = parseDate(checkOut);
  if (!ci || !co) return null;
  const ms = co.getTime() - ci.getTime();
  if (ms <= 0) return null;
  return Math.round(ms / 86_400_000);
}

/** Compact party caption, e.g. "12–15 Jul · 2 guests" or "2 guests". */
export function partyCaption(entry: EntryListItem): string {
  const range = formatStayRange(entry.checkInDate, entry.checkOutDate);
  const guests = entry.guestCount ? `${entry.guestCount} guest${entry.guestCount === 1 ? "" : "s"}` : null;
  return [range, guests].filter(Boolean).join(" · ") || "Stay being shaped";
}

/** Statuses that take a booking off the active desk. */
export function isLiveStatus(status: EntryStatus): boolean {
  return status === "ACTIVE" || status === "PARKED";
}

/** Dwell since a booking last moved — the desk's honest "is this stuck?" signal. */
export type DeskTimer = { text: string; level: "" | "warn" | "crit" };

export function dwellTimer(updatedAt: string, now: number = Date.now()): DeskTimer {
  const ms = now - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { text: "just now", level: "" };
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let text: string;
  if (mins < 1) text = "just now";
  else if (mins < 60) text = `${mins}m idle`;
  else if (hours < 24) text = `${hours}h ${mins % 60}m idle`;
  else text = `${days}d ${hours % 24}h idle`;
  const level: DeskTimer["level"] = days >= 2 ? "crit" : hours >= 24 ? "warn" : "";
  return { text, level };
}

/** A booking as the front desk sees it — derived once, consumed everywhere. */
export type DeskBooking = {
  id: string;
  inquiryId: string;
  name: string;
  initials: string;
  avatar: string;
  party: string;
  step: DeskStep;
  status: EntryStatus;
  need: string;
  timer: DeskTimer;
  updatedAt: string;
  createdAt: string;
  checkInDate?: string | null;
  checkOutDate?: string | null;
};

export function toDeskBooking(entry: EntryListItem, now: number = Date.now()): DeskBooking {
  const name = guestName(entry.guestProfile ?? entry.inquiry?.guestProfile);
  const step = stepForStage(entry.currentStage);
  return {
    id: entry.id,
    inquiryId: entry.inquiryId,
    name,
    initials: initialsOf(name),
    avatar: avatarColor(entry.id),
    party: partyCaption(entry),
    step,
    status: entry.status,
    need: step.need,
    timer: dwellTimer(entry.updatedAt, now),
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    checkInDate: entry.checkInDate,
    checkOutDate: entry.checkOutDate,
  };
}
