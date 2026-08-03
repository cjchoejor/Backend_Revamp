"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, RefreshCw, X } from "lucide-react";
import { getEntryTimers, type TimerRecordSummary } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "booking-timer-panel-open";

type Props = { entryId: string };

/**
 * Right-side countdown panel shown during the booking flow. Lists every SCHEDULED timer the
 * backend has pinned to this entry (S1 inquiry expiry, S2 speculative hold expiry, advance
 * payment follow-up, etc.) with a live countdown. Re-fetches every 15s and re-renders the
 * clock every second so the value the operator reads is the value that will actually fire.
 */
export function BookingTimerPanel({ entryId }: Props) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1");
  }, []);
  const setOpenPersisted = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  // Fetch timers regardless of open/closed so the minimized button can show the next-due
  // countdown's label + remaining time without the user having to expand the drawer.
  const query = useQuery({
    queryKey: ["entry-timers", entryId],
    queryFn: () => getEntryTimers(session!, entryId),
    enabled: !!session && !!entryId,
    refetchInterval: 15_000,
  });

  // Tick the local clock every second whether open or closed so the minimized button's
  // countdown visibly advances. Browsers throttle setInterval in background tabs anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!session || !entryId) return null;

  const items = query.data?.items ?? [];
  const next = items[0]; // sorted by firesAt asc upstream
  const nextLabel = next ? labelForTimer(next) : null;
  const nextTone = next ? getCountdownTone(next, now) : "normal";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpenPersisted(true)}
        className={cn(
          "fixed bottom-20 right-4 z-40 flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-sm font-medium shadow-lg transition hover:bg-accent",
          nextTone === "critical" && "border-red-500/60 ring-2 ring-red-500/30",
          nextTone === "warn" && "border-amber-500/60",
          nextTone === "normal" && "border-border",
        )}
        aria-label="Show timers"
        title={next ? `${nextLabel} — ${formatCountdown(next.firesAt, now)}` : "No active timers"}
      >
        <Clock
          className={cn(
            "h-4 w-4 shrink-0",
            nextTone === "critical" && "text-red-600 dark:text-red-400",
            nextTone === "warn" && "text-amber-600 dark:text-amber-400",
            nextTone === "normal" && "text-muted-foreground",
          )}
        />
        {next ? (
          <>
            <span className="text-xs">{nextLabel}</span>
            <span
              className={cn(
                "font-mono text-sm",
                nextTone === "critical" && "text-red-700 dark:text-red-300",
                nextTone === "warn" && "text-amber-700 dark:text-amber-300",
              )}
            >
              {formatCountdown(next.firesAt, now)}
            </span>
            {items.length > 1 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                +{items.length - 1}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs">Timers</span>
        )}
      </button>
    );
  }

  return (
    <aside className="fixed right-0 top-16 bottom-0 z-40 flex w-[300px] max-w-[90vw] flex-col border-l border-border bg-card shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Timers</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => query.refetch()}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setOpenPersisted(false)}
            aria-label="Hide timers"
            title="Hide"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Active countdowns for this booking. Values are the actual workers' fire times.
      </p>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {query.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {!query.isLoading && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No active timers for this booking.</p>
        )}
        <ul className="space-y-2">
          {items.map((t) => (
            <TimerRow key={t.id} timer={t} now={now} />
          ))}
        </ul>
      </div>
    </aside>
  );
}

function TimerRow({ timer, now }: { timer: TimerRecordSummary; now: number }) {
  const tone = getCountdownTone(timer, now);
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        tone === "critical" && "border-red-500/40 bg-red-500/5",
        tone === "warn" && "border-amber-500/40 bg-amber-500/5",
        tone === "normal" && "border-border bg-muted/20",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{labelForTimer(timer)}</span>
        <span
          className={cn(
            "font-mono",
            tone === "critical" && "text-red-700 dark:text-red-300",
            tone === "warn" && "text-amber-700 dark:text-amber-300",
            tone === "normal" && "text-foreground",
          )}
        >
          {formatCountdown(timer.firesAt, now)}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        fires {new Date(timer.firesAt).toLocaleString()}
        {timer.stageContext && <span className="ml-1 rounded bg-muted px-1">{timer.stageContext}</span>}
      </div>
    </li>
  );
}

/**
 * Friendly operator-facing label. Reads the most specific signal first (timerType /
 * timerCode), then falls back to the stage context so unmatched timers still say e.g.
 * "S2 timer" rather than a raw enum. Each branch is short on purpose — the label sits in a
 * pill on the minimized button alongside the countdown, so brevity matters.
 */
function labelForTimer(t: TimerRecordSummary): string {
  const key = `${t.timerType}.${t.timerCode}`.toUpperCase();
  if (key.includes("S1") && key.includes("EXPIR")) return "Inquiry expiry";
  if (key.includes("S1_EXPIRY") || t.timerType === "S1_EXPIRY") return "Inquiry expiry";
  if (key.includes("QUOTATION") || key.includes("QUOTE")) return "Quote validity";
  if (key.includes("SPECULATIVE") || (key.includes("S2") && key.includes("HOLD"))) return "Speculative hold";
  if (key.includes("COMMITTED") || (key.includes("S3") && key.includes("HOLD"))) return "Reservation hold";
  if (key.includes("ADVANCE_PAYMENT") || key.includes("DEPOSIT_FOLLOWUP")) return "Advance payment follow-up";
  if (key.includes("PRE_ARRIVAL")) return "Pre-arrival window";
  if (key.includes("NO_SHOW") || key.includes("NOSHOW")) return "No-show cutoff";
  if (key.includes("HANDOFF")) return "Handoff acknowledgement";
  if (key.includes("DWELL")) return "Stage dwell";
  if (key.includes("CHECKOUT")) return "Checkout cutoff";
  // Stage-context fallback so unmapped timers still say something useful
  if (t.stageContext) return `${t.stageContext} timer`;
  return t.timerType.replace(/_/g, " ").replace(/\./g, " · ");
}

function getCountdownTone(t: TimerRecordSummary, now: number): "critical" | "warn" | "normal" {
  const firesMs = new Date(t.firesAt).getTime();
  const criticalMs = t.criticalAt ? new Date(t.criticalAt).getTime() : null;
  const warningMs = t.warningAt ? new Date(t.warningAt).getTime() : null;
  if (criticalMs && now >= criticalMs) return "critical";
  if (warningMs && now >= warningMs) return "warn";
  // Fallback heuristic if the backend didn't set warning/critical thresholds
  const remaining = firesMs - now;
  if (remaining < 5 * 60_000) return "critical";
  if (remaining < 30 * 60_000) return "warn";
  return "normal";
}

function formatCountdown(firesAt: string, now: number): string {
  const remainingMs = new Date(firesAt).getTime() - now;
  if (remainingMs <= 0) return "00:00";
  const totalSec = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
