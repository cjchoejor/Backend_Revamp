/**
 * Today's lists (SS01) — derived on the screen from the bookings read until the backend's Today
 * feed exists (register SS01-P1). SS01 §7: "the screen selects by date and step in memory; that is
 * selection, not arithmetic." Every rule here is a date or a step comparison; no money is worked
 * out, and a row only appears when the booking itself says it needs a person.
 */
import type { DeskListRow } from "@/lib/api/desk";
import { fmtDateTime, fmtDay, instantYmd, span } from "./format";
import { bookerOfRow, guestNameOf } from "./status";
import { stepNoOfStage, type StepNo } from "./steps";

export type Band = "overdue" | "soon" | "waiting";

export type AttentionItem = {
  key: string;
  entryId: string;
  name: string;
  named: boolean;
  /** The grey line: reference · booker. */
  meta: string;
  step: StepNo;
  need: string;
  band: Band;
  /** What runs out, and when (instant ms) — shown as a countdown / "overdue". */
  deadline?: { label: string; at: number };
  /** How long it has waited (instant ms). */
  since?: number;
  /** For folding identical work from one source (SS01 §3.2). */
  foldKey: string;
  sourceWord: string;
};

export type Fold = { kind: "fold"; key: string; count: number; need: string; sourceWord: string; band: Band; step: StepNo; entryIds: string[] };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function base(r: DeskListRow): Pick<AttentionItem, "entryId" | "name" | "named" | "meta" | "step" | "sourceWord"> {
  const booker = bookerOfRow(r);
  const name = guestNameOf(r.guestProfile);
  const sourceWord = booker?.kind === "agent" || booker?.kind === "company" ? booker.name : booker?.kind === "ota" ? "OTA" : booker?.kind === "walk-in" ? "Walk-in" : "Direct";
  return {
    entryId: r.id,
    name,
    named: name !== "to come from the agent",
    meta: [r.id, booker && booker.kind !== "direct" ? booker.name : null].filter(Boolean).join(" · "),
    step: stepNoOfStage(r.currentStage),
    sourceWord,
  };
}

function effectiveCheckout(r: DeskListRow): string | null {
  return (r.actualCheckOutDate ?? r.checkOutDate)?.slice(0, 10) ?? null;
}

/**
 * Everything that needs a person now, whatever its date (SS01 §3.2). Ordered: overdue first,
 * then closest to a deadline, then longest waiting.
 */
export function attentionItems(rows: DeskListRow[], now: number, hotelToday: string | null, tz: string): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (!hotelToday) return out;
  const tomorrow = nextYmd(hotelToday);
  const push = (r: DeskListRow, it: Omit<AttentionItem, keyof ReturnType<typeof base> | "key" | "foldKey"> & { foldKey?: string }) => {
    const b = base(r);
    out.push({ ...b, ...it, key: `${r.id}:${it.need}`, foldKey: `${it.need}|${b.sourceWord}` });
  };

  for (const r of rows) {
    const step = stepNoOfStage(r.currentStage);
    const ci = r.checkInDate?.slice(0, 10) ?? null;
    const co = effectiveCheckout(r);

    if (r.status === "PARKED") {
      if (r.parkFollowUpAt && new Date(r.parkFollowUpAt).getTime() <= now) {
        const days = r.parkedAt ? Math.floor((now - new Date(r.parkedAt).getTime()) / DAY) : null;
        push(r, { need: `Follow up · parked${days != null ? ` ${days} day${days === 1 ? "" : "s"}` : ""}`, band: "soon", since: r.parkedAt ? new Date(r.parkedAt).getTime() : undefined });
      }
      continue;
    }
    if (r.status !== "ACTIVE") continue;

    // Money promised mid-stay
    for (const ip of r.interimPaymentRequests) {
      if (!ip.dueBy) continue;
      const at = new Date(ip.dueBy).getTime();
      const what = ip.kind === "EXTENSION" ? "Extension payment" : "Mid-stay payment";
      if (at <= now) push(r, { need: `${what} overdue`, band: "overdue", deadline: { label: "Due", at } });
      else if (at - now < DAY) push(r, { need: `${what} due`, band: "soon", deadline: { label: "Due", at } });
    }

    // An arrival date that has passed before check-in
    if (ci && ci < hotelToday && step >= 3 && step <= 6) {
      push(r, { need: "Arrival date passed — check in, or record what happened", band: "overdue", deadline: { label: "Arrival was", at: ymdStart(ci) } });
      continue;
    }

    // The advance still owed on a booking that arrives today or tomorrow
    if (r.reservationPaymentPending && ci && (ci === hotelToday || ci === tomorrow) && step >= 4 && step <= 5) {
      push(r, { need: `Advance not in · arrives ${ci === hotelToday ? "today" : "tomorrow"}`, band: "overdue" });
    }

    if (step === 2) {
      const marker = r.speculativeHolds[0]?.expiresAt;
      const q = r.quotations[0];
      if (marker && new Date(marker).getTime() - now < DAY) {
        push(r, { need: "Agent deciding", band: "soon", deadline: { label: "Marker ends", at: new Date(marker).getTime() } });
      } else if (q?.state === "SENT" && q.validUntil && new Date(q.validUntil).getTime() - now < DAY) {
        push(r, { need: "The quote is running out", band: "soon", deadline: { label: "Quote valid", at: new Date(q.validUntil).getTime() } });
      } else if (ci && ci >= hotelToday && now - new Date(r.updatedAt).getTime() > 2 * DAY) {
        push(r, { need: "No answer recorded", band: "waiting", since: new Date(r.updatedAt).getTime() });
      }
    } else if (step === 1) {
      if (ci && ci >= hotelToday && now - new Date(r.updatedAt).getTime() > 2 * DAY) {
        push(r, { need: "No answer recorded", band: "waiting", since: new Date(r.updatedAt).getTime() });
      }
    } else if (step === 3) {
      const hold = r.committedHold;
      if (hold && (hold.state === "PLACED") && new Date(hold.expiresAt).getTime() - now < DAY) {
        const at = new Date(hold.expiresAt).getTime();
        push(r, { need: at <= now ? "The block ran out" : "The block is running out", band: at <= now ? "overdue" : "soon", deadline: { label: "Block ends", at } });
      } else if (!hold) {
        push(r, { need: "Not yet blocked", band: "waiting", since: new Date(r.updatedAt).getTime() });
      }
    } else if (step === 4) {
      if (r.reservation && !r.reservation.confirmationVoucherSent) push(r, { need: "Reserved · voucher not sent", band: "soon" });
    } else if (step === 7) {
      if (co && co < hotelToday) push(r, { need: "Check-out date passed", band: "overdue", deadline: { label: "Check-out was", at: ymdStart(co) } });
    } else if (step === 8) {
      push(r, { need: "Settle the bill and close the stay", band: "soon", since: new Date(r.updatedAt).getTime() });
    } else if (step === 9) {
      if (r.folio?.state === "OUTSTANDING") push(r, { need: "Money still owed after the stay", band: "waiting", since: new Date(r.updatedAt).getTime() });
      // A no-show waits at Closed for its seal (2026-09-18) — nothing else would bring it back.
      else if (r.folio?.state === "NO_SHOW_CLOSED" && r.status === "ACTIVE") push(r, { need: "A no-show to seal", band: "waiting", since: new Date(r.updatedAt).getTime() });
    }
    void tz;
  }

  const bandRank: Record<Band, number> = { overdue: 0, soon: 1, waiting: 2 };
  return out.sort((a, b) => {
    const d = bandRank[a.band] - bandRank[b.band];
    if (d) return d;
    const ad = a.deadline?.at ?? Number.POSITIVE_INFINITY;
    const bd = b.deadline?.at ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return (a.since ?? now) - (b.since ?? now);
  });
}

/** Identical work from one source collapses into one row with a count (SS01 §3.2). */
export function foldAttention(items: AttentionItem[], min = 4): Array<AttentionItem | Fold> {
  const groups = new Map<string, AttentionItem[]>();
  for (const it of items) {
    const g = groups.get(it.foldKey) ?? [];
    g.push(it);
    groups.set(it.foldKey, g);
  }
  const out: Array<AttentionItem | Fold> = [];
  const emitted = new Set<string>();
  for (const it of items) {
    const g = groups.get(it.foldKey)!;
    if (g.length >= min) {
      if (emitted.has(it.foldKey)) continue;
      emitted.add(it.foldKey);
      out.push({ kind: "fold", key: it.foldKey, count: g.length, need: it.need, sourceWord: it.sourceWord, band: it.band, step: it.step, entryIds: g.map((x) => x.entryId) });
    } else out.push(it);
  }
  return out;
}

export function isFold(x: AttentionItem | Fold): x is Fold {
  return (x as Fold).kind === "fold";
}

/** "Marker ends · 12 Sep, 5:00 PM" / "overdue 3 days" — what the Waiting column says. */
export type WaitingText = { label: string; value: string; tone: "" | "close" | "overdue"; text: string };
export function waitingText(it: AttentionItem, now: number, tz: string): WaitingText {
  const out = (label: string, value: string, tone: WaitingText["tone"]): WaitingText => ({ label, value, tone, text: [label, value].filter(Boolean).join(" ") });
  if (it.deadline) {
    if (it.deadline.at <= now) return out(it.deadline.label, `overdue ${span(now - it.deadline.at)}`, "overdue");
    return out(it.deadline.label, fmtDateTime(it.deadline.at, tz), it.deadline.at - now < 6 * HOUR ? "close" : "");
  }
  if (it.since) return out("Waiting", span(now - it.since), it.band === "overdue" ? "overdue" : "");
  return out("", "", it.band === "overdue" ? "overdue" : "");
}

/* ---------- the hotel's day ---------- */

export type DayLists = {
  arriving: DeskListRow[];
  leaving: DeskListRow[];
  inHouse: DeskListRow[];
  newInquiries: DeskListRow[];
  parked: DeskListRow[];
  /** Inquiries whose dates passed with no outcome recorded. */
  noOutcome: DeskListRow[];
  /** Open inquiries with no date at all. */
  noDate: DeskListRow[];
};

export function dayLists(rows: DeskListRow[], hotelToday: string | null, tz: string): DayLists {
  const empty: DayLists = { arriving: [], leaving: [], inHouse: [], newInquiries: [], parked: [], noOutcome: [], noDate: [] };
  if (!hotelToday) return empty;
  for (const r of rows) {
    const step = stepNoOfStage(r.currentStage);
    const ci = r.checkInDate?.slice(0, 10) ?? null;
    const co = effectiveCheckout(r);
    if (r.status === "PARKED") {
      empty.parked.push(r);
      continue;
    }
    if (r.status !== "ACTIVE") continue;
    if (ci === hotelToday && step >= 4 && step <= 6) empty.arriving.push(r);
    if (step === 7 || step === 8) {
      empty.inHouse.push(r);
      if (co === hotelToday || (co && co < hotelToday)) empty.leaving.push(r);
    }
    if (step <= 2) {
      if (instantYmd(r.createdAt, tz) === hotelToday) empty.newInquiries.push(r);
      if (!ci) empty.noDate.push(r);
      else if (ci < hotelToday) empty.noOutcome.push(r);
    }
  }
  empty.arriving.sort((a, b) => stepNoOfStage(b.currentStage) - stepNoOfStage(a.currentStage));
  empty.newInquiries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  empty.parked.sort((a, b) => (a.parkFollowUpAt ?? "").localeCompare(b.parkFollowUpAt ?? ""));
  return empty;
}

/** Nights left for an in-house guest: "leaves today" or "2 nights left". */
export function nightsLeft(r: DeskListRow, hotelToday: string | null): string {
  const co = effectiveCheckout(r);
  if (!co || !hotelToday) return "—";
  if (co <= hotelToday) return "leaves today";
  const n = Math.round((ymdStart(co) - ymdStart(hotelToday)) / DAY);
  return `${n} night${n === 1 ? "" : "s"} left · leaves ${fmtDay(co)}`;
}

function ymdStart(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function nextYmd(ymd: string): string {
  return new Date(ymdStart(ymd) + DAY).toISOString().slice(0, 10);
}
