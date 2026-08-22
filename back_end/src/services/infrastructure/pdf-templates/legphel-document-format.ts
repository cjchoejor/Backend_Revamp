/**
 * Date / range formatters for the Legphel house document format.
 *
 * The reference cards in `docs/bills` use "28 Jul 2026" — NOT the "DD-MM-YYYY" of the older
 * templates (`formatDate` in pdf-render-context, which those templates still use). Keeping both is
 * deliberate: the old room-invoice layout is unchanged, and only the Family-A documents move to the
 * new house style.
 *
 * All formatting is UTC-based, matching `formatDate`, so a stay date never shifts a day because the
 * rendering host sits in a different timezone from the property.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "28 Jul 2026" */
export function formatDocDate(d: Date | null | undefined): string {
  if (!d) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The property's clock for "as at" stamps (2026-08-22). Every other formatter here is UTC-based
 * because a stay DATE must never shift a day with the host's zone; a statement's as-at TIME is
 * the opposite case — it must read as the wall clock at the desk. Bhutan has one zone;
 * overridable for a host elsewhere via `HOTEL_TIMEZONE`.
 */
export const HOTEL_TIMEZONE = process.env.HOTEL_TIMEZONE?.trim() || "Asia/Thimphu";

/** "22 Aug 2026 · 14:05" in the property's local time — the Interim Folio Statement's as-at. */
export function formatDocDateTimeLocal(d: Date | null | undefined): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: HOTEL_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")} · ${get("hour")}:${get("minute")}`;
}

/** The property's local calendar date ("2026-08-22") for a given instant. */
export function localYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: HOTEL_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "08 Sep 2026 · 14:00" — voucher check-in / check-out rows. */
export function formatDocDateTime(d: Date | null | undefined, clockTime: string | null): string {
  if (!d) return "";
  const base = formatDocDate(d);
  return clockTime ? `${base} · ${clockTime}` : base;
}

/**
 * "20 Oct — 22 Oct 2026 · 2 nights" (em dash, as the reference uses).
 *
 * Collapses a shared year onto the end and a shared month onto the second date, so the reference's
 * compact "10–12 Oct 2026" form comes out for a same-month stay rather than a repetitive
 * "10 Oct 2026 — 12 Oct 2026".
 */
export function formatStayRange(
  from: Date | null | undefined,
  to: Date | null | undefined,
  nights: number | null,
): string {
  const suffix = nights != null ? ` · ${nights} night${nights === 1 ? "" : "s"}` : "";
  if (!from || !to) return (from ? formatDocDate(from) : to ? formatDocDate(to) : "") + suffix;

  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const sameMonth = sameYear && from.getUTCMonth() === to.getUTCMonth();

  if (sameMonth) {
    // "10–12 Oct 2026"
    return `${String(from.getUTCDate()).padStart(2, "0")}–${formatDocDate(to)}${suffix}`;
  }
  if (sameYear) {
    // "20 Oct — 22 Nov 2026"
    const left = `${String(from.getUTCDate()).padStart(2, "0")} ${MONTHS[from.getUTCMonth()]}`;
    return `${left} — ${formatDocDate(to)}${suffix}`;
  }
  return `${formatDocDate(from)} — ${formatDocDate(to)}${suffix}`;
}

/**
 * "38 days before arrival" / "on arrival day" / "4 days after arrival" — the cancellation
 * document's Notice given row, which is what selects the refund band.
 */
export function formatNoticeGiven(cancelledAt: Date, checkIn: Date | null | undefined): string {
  if (!checkIn) return "—";
  const day = 86_400_000;
  const a = Date.UTC(cancelledAt.getUTCFullYear(), cancelledAt.getUTCMonth(), cancelledAt.getUTCDate());
  const b = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  const days = Math.round((b - a) / day);
  if (days === 0) return "on arrival day";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} before arrival`;
  return `${-days} day${days === -1 ? "" : "s"} after arrival`;
}
