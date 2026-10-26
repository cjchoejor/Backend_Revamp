"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getTimerFailures, type TimerFailureAdmin } from "@/lib/api/admin";
import { timerLabel } from "@/lib/ds/timers";
import { fmtDateTime } from "@/lib/ds/format";

/**
 * The timers that failed (2026-10-26). A timer job that fails every retry is sent once more by
 * the hourly sweep in the workers; one that fails again is given up and listed here for a person
 * to look at. Read-only — every word and state comes from GET /api/admin/timer-failures.
 */

// The system's own clocks have no desk words (timerLabel returns null); name them here.
const SYSTEM_TIMERS: Record<string, string> = {
  NIGHT_AUDIT_W6: "The night audit",
  STAGE_DWELL_MONITOR: "Time-at-step reminder",
  PROCESSING_LOCK_TTL: "Booking lock",
  OTA_EMAIL_PARSER_POLL: "Online booking mail check",
  QUOTATION_ACK_TRACKER: "Quotation answer check",
  CREDIT_CEILING_MONITORING_W12: "Credit limit check",
  FEEDBACK_SOLICITATION_W28: "Feedback request",
  AI_AUDIT_SUPPLEMENT_W18: "Audit supplement",
  GUEST_DATA_RETENTION_P18: "Guest data clean-up",
  LOST_FOUND_RETENTION_W30: "Lost and found clean-up",
  FOM_OVERRIDE_FREQUENCY_W32: "Front office manager sign-off count",
  IDENTITY_OCR_W39: "Reading an ID photo",
};

function timerName(queue: string): string {
  return timerLabel({ timerType: queue }) ?? SYSTEM_TIMERS[queue] ?? "A system timer";
}

function outcomeOf(f: TimerFailureAdmin): { tag: string; tone: "ok" | "warn" | "plain"; line: string } {
  const h = f.handled;
  if (!h) return { tag: "Not looked at yet", tone: "plain", line: "The next hourly check sends it again" };
  if (h.outcome === "GAVE_UP") {
    return { tag: "Given up", tone: "warn", line: `${h.reason} — ${f.entryId ? "put it right on the booking" : "put it right by hand"}` };
  }
  if (h.outcome === "LEFT") return { tag: "Left alone", tone: "plain", line: h.reason };
  const s = h.newJobState;
  if (s === "completed") return { tag: "Sent again · it ran", tone: "ok", line: "Sent once more, and it ran" };
  if (s === "failed") return { tag: "Failed again", tone: "warn", line: "Sent once more and failed again — the next check gives it up" };
  if (s === "gone") return { tag: "Sent again", tone: "plain", line: "Sent once more; its record has since been cleared" };
  return { tag: "Sent again · waiting", tone: "plain", line: "Sent once more — waiting to run" };
}

function Row({ f }: { f: TimerFailureAdmin }) {
  const [open, setOpen] = useState(false);
  const o = outcomeOf(f);
  return (
    <>
      <tr className="border-b border-border align-top">
        <td className="whitespace-nowrap px-3 py-2 text-sm font-medium">{timerName(f.queue)}</td>
        <td className="whitespace-nowrap px-3 py-2 text-sm">{fmtDateTime(f.dueAt)}</td>
        <td className="whitespace-nowrap px-3 py-2 text-sm">{fmtDateTime(f.failedAt)}</td>
        <td className="px-3 py-2 text-sm">
          <span className={o.tone === "ok" ? "admin-tag admin-tag-ok" : o.tone === "warn" ? "admin-tag admin-tag-warn" : "admin-tag"}>{o.tag}</span>
          <div className="mt-1 text-xs text-[var(--admin-ink-soft)]">{o.line}</div>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-sm">
          {f.entryId ? (
            <Link className="underline" href={`/bookings/${encodeURIComponent(f.entryId)}`}>
              {f.entryId}
            </Link>
          ) : (
            <span className="text-[var(--admin-ink-soft)]">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          <button type="button" className="admin-btn admin-btn-ghost admin-btn-sm whitespace-nowrap" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide details" : "Details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-[var(--admin-bg)]/50">
          <td colSpan={6} className="px-3 py-2 text-xs">
            <div>
              <strong>What went wrong:</strong> {f.error ?? "no message was kept"}
            </div>
            <div className="mt-1 font-mono text-[var(--admin-ink-soft)]">
              {f.queue} · job {f.id} · tried {f.attempts} {f.attempts === 1 ? "time" : "times"}
              {f.handled?.newJobId ? ` · sent again as ${f.handled.newJobId}` : ""}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function TimerFailuresPanel() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["admin", "timer-failures"],
    queryFn: () => getTimerFailures(session!),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const failures = q.data?.failures ?? [];
  const gaveUp = failures.filter((f) => f.handled?.outcome === "GAVE_UP" || f.handled?.newJobState === "failed").length;
  const days = q.data?.lookbackDays ?? 7;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="admin-display text-xl">Timers that failed</h2>
        <p className="mt-1 text-sm">
          {q.isLoading ? (
            "Checking…"
          ) : q.isError ? (
            <span className="font-semibold text-[var(--destructive)]">The list could not be read.</span>
          ) : failures.length === 0 ? (
            <span className="font-semibold text-[var(--success)]">No timer has failed in the last {days} days.</span>
          ) : gaveUp > 0 ? (
            <span className="font-semibold text-[var(--destructive)]" role="alert">
              {gaveUp} {gaveUp === 1 ? "timer has" : "timers have"} been given up — look at {gaveUp === 1 ? "it" : "them"} below.
            </span>
          ) : (
            <span className="font-semibold">
              {failures.length} {failures.length === 1 ? "timer" : "timers"} failed in the last {days} days, and none has been given up.
            </span>
          )}
        </p>
        <details className="mt-1 text-xs text-[var(--admin-ink-soft)]">
          <summary className="cursor-pointer">What is this?</summary>
          <p className="mt-1 max-w-2xl">
            A timer is the system&apos;s own reminder that something is due — a hold that ends, a no-show cut-off, a room
            to be cleaned by a time. When one fails it is tried five more times over about a quarter of an hour. If it
            still fails, the hourly check sends it once more; if that fails too, it is given up and shown here so a
            person can put it right on the booking. A timer whose booking has moved on is left alone. Failed timers
            are kept for seven days.
          </p>
        </details>
      </div>
      {failures.length > 0 && (
        <div className="admin-panel overflow-x-auto p-0">
          <table className="w-full text-left">
            <thead className="border-b border-border bg-[var(--admin-bg)]/50">
              <tr className="text-xs uppercase tracking-wide text-[var(--admin-ink-soft)]">
                <th className="px-3 py-2">Timer</th>
                <th className="px-3 py-2">Was due</th>
                <th className="px-3 py-2">Failed</th>
                <th className="px-3 py-2">What happened</th>
                <th className="px-3 py-2">Booking</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <Row key={f.id} f={f} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
