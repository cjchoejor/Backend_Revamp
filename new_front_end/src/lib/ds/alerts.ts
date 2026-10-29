/**
 * The alerts the system sent, in the desk's words (2026-10-23) — the notifications page's second
 * tab. The backend reads the `NOTIFICATION.*` traces into one shape (`GET /api/desk/alerts`); this
 * module words each one, says how its booking stands now, and groups them by hotel day with the
 * repeats of one booking folded together. Selection and wording only — nothing is worked out.
 */
import type { DeskAlert, DeskAlertKind, DeskAlertTarget } from "@/lib/api/desk";
import { instantYmd, money, span } from "./format";
import { endingOf, rowNameOf, rowNamed } from "./status";
import { stepName, stepNoOfStage } from "./steps";

export const TARGET_WORD: Record<DeskAlertTarget, string> = { OPERATOR: "Front desk", FOM: "FOM", GM: "GM" };
export const TARGET_ORDER: DeskAlertTarget[] = ["OPERATOR", "FOM", "GM"];

export const ALERT_KIND_WORD: Record<DeskAlertKind, string> = {
  STAGE_DWELL: "Too long at a step",
  EXPIRED: "Lapsed",
  PAYMENT_REMINDER: "Payment reminder",
  PAY_LATER_ASKED: "Asks to pay later",
  VIP_ARRIVAL: "VIP arrival",
  OTHER: "Alert",
};

const SEVERITY_WORD = { WARNING: "warning", CRITICAL: "critical", ESCALATION: "escalated" } as const;
const SEVERITY_RANK = { WARNING: 1, CRITICAL: 2, ESCALATION: 3 } as const;

/** "warning" / "critical" / "escalated", or null for an alert that has no severity. */
export function severityWord(a: DeskAlert): string | null {
  return a.severity ? SEVERITY_WORD[a.severity] : null;
}

const stepOf = (stage: string | null | undefined) => (stage ? stepName(stepNoOfStage(stage)) : null);

/** What the alert said, in one line. */
export function alertHeadline(a: DeskAlert): string {
  switch (a.kind) {
    case "STAGE_DWELL": {
      const step = stepOf(a.stage) ?? "a step";
      return a.secondsInStage != null ? `At ${step} for ${span(a.secondsInStage * 1000)}` : `Too long at ${step}`;
    }
    case "EXPIRED":
      if (a.reason === "ENTRY_STAGE_TTL_EXPIRED") return "Lapsed — nobody acted before its clock ran out";
      if (a.reason === "PROCESSING_LOCK_TTL_EXPIRED") return "A search's hold on the rooms ran out";
      return "Its clock ran out";
    case "PAYMENT_REMINDER": {
      const p = a.payment;
      const what = p?.kind === "EXTENSION" ? "Extension payment" : p?.kind === "CHECKIN" ? "The rest of the bill" : "Mid-stay payment";
      return [`${what} still owed`, p?.remaining != null ? money(p.remaining) : null, p?.remindersSent ? `reminder ${p.remindersSent}` : null].filter(Boolean).join(" · ");
    }
    case "PAY_LATER_ASKED":
      return [`Asks to pay the rest of the bill later — the FOM decides`, a.payment?.remaining != null ? money(a.payment.remaining) : null].filter(Boolean).join(" · ");
    case "VIP_ARRIVAL":
      return "A VIP is arriving — the departments were told";
    default:
      return a.eventType.replace(/^NOTIFICATION\./, "").toLowerCase().replace(/_/g, " ");
  }
}

/** The booking's name as the lists write it, or its reference when it is no longer on record. */
export function alertBookingName(a: DeskAlert): { name: string; named: boolean } {
  const b = a.booking;
  if (!b) return { name: a.entryId ?? "No booking", named: false };
  return { name: rowNameOf(b), named: rowNamed(b) };
}

export type AlertNow = { text: string; tone: "warn" | "ok" | "quiet" };

/** How the booking stands now, against what the alert was about. */
export function alertNow(a: DeskAlert): AlertNow {
  const b = a.booking;
  if (!b) return { text: "No longer on record", tone: "quiet" };
  const now = stepOf(b.currentStage) ?? "—";
  if (b.status === "CANCELLED" || b.status === "EXPIRED" || b.status === "CLOSED") {
    const ending = endingOf(b.closedAs);
    const word = ending?.word ?? (b.status === "CLOSED" ? "Closed" : b.status === "CANCELLED" ? "Cancelled" : "Lapsed");
    return { text: `Ended · ${word}${ending?.qualifier ? `, ${ending.qualifier}` : ""}`, tone: "quiet" };
  }
  const parked = b.status === "PARKED" ? " · parked" : "";
  if (a.kind === "STAGE_DWELL" && a.stage && b.currentStage === a.stage) return { text: `Still at ${now}${parked}`, tone: "warn" };
  if (a.kind === "STAGE_DWELL") return { text: `Moved on · now at ${now}${parked}`, tone: "ok" };
  return { text: `Now at ${now}${parked}`, tone: "quiet" };
}

/** One booking's alerts of one kind on one day, newest first — read as one row. */
export type AlertGroup = { key: string; head: DeskAlert; alerts: DeskAlert[] };
export type AlertDay = { ymd: string; groups: AlertGroup[]; count: number };

/**
 * Alerts by hotel day, newest day first. Within a day, the repeats for one booking at one step
 * (a warning, then critical, then escalated) fold into one row headed by the most severe, newest
 * alert; the row keeps the others for its "also" line.
 */
export function alertsByDay(alerts: DeskAlert[], tz: string): AlertDay[] {
  const days = new Map<string, Map<string, DeskAlert[]>>();
  for (const a of alerts) {
    const ymd = instantYmd(a.at, tz) ?? a.at.slice(0, 10);
    const groups = days.get(ymd) ?? new Map<string, DeskAlert[]>();
    const key = `${a.entryId ?? a.id}|${a.kind}|${a.stage ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
    days.set(ymd, groups);
  }
  const rank = (a: DeskAlert) => (a.severity ? SEVERITY_RANK[a.severity] : 0);
  return [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([ymd, groups]) => {
      const out = [...groups.entries()].map(([key, list]) => {
        const sorted = [...list].sort((x, y) => y.at.localeCompare(x.at));
        const head = [...sorted].sort((x, y) => rank(y) - rank(x) || y.at.localeCompare(x.at))[0];
        return { key: `${ymd}|${key}`, head, alerts: sorted };
      });
      out.sort((x, y) => y.alerts[0].at.localeCompare(x.alerts[0].at));
      return { ymd, groups: out, count: out.reduce((n, g) => n + g.alerts.length, 0) };
    });
}

/** Everyone an alert group was routed to, in the order front desk · FOM · GM. */
export function groupTargets(g: AlertGroup): DeskAlertTarget[] {
  const set = new Set(g.alerts.flatMap((a) => a.targets));
  return TARGET_ORDER.filter((t) => set.has(t));
}
