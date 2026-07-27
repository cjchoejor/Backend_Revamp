/**
 * Human labels for the raw backend timer codes shown in the desk's "Backend activity" feed and
 * the "Under the hood" view, plus a helper to spot timers whose stage has already passed.
 *
 * The one that most needs disambiguating is ACKNOWLEDGEMENT_WINDOW_W22: the same code is armed
 * once per outbound guest message that awaits a reply (quotation at S2, confirmation voucher at
 * S4, pre-arrival reminder at S5), so several show at once and read like duplicates. We use the
 * timer's `stageContext` to say which message each one belongs to.
 */

type TimerLike = { timerCode?: string | null; timerType?: string | null; stageContext?: string | null };

/** Which outbound message an acknowledgement window belongs to, keyed by the stage it was sent at. */
const ACK_MESSAGE_BY_STAGE: Record<string, string> = {
  S2: "Quotation",
  S3: "Proforma invoice",
  S4: "Confirmation voucher",
  S5: "Pre-arrival reminder",
};

const TIMER_LABELS: Record<string, string> = {
  PRE_ARRIVAL_COUNTDOWN_W4: "Pre-arrival countdown",
  NO_SHOW_CUTOFF_W5: "No-show cutoff",
  AWAITING_WRITTEN_CONFIRMATION_W5: "Awaiting written confirmation",
  STAGE_DWELL_MONITOR: "Stage dwell monitor",
  SPECULATIVE_HOLD_EXPIRY_W2: "Speculative hold expiry",
  COMMITTED_HOLD_EXPIRY_W3: "Committed hold expiry",
  ENTRY_EXPIRY: "Inquiry expiry",
  // Armed on park in place of the short stage-expiry timer: a parked booking still expires, but
  // only after the long park window (expiry.parking.followUpDays, 30d default) — SIG-S1 §3.4.
  PARKING_FOLLOW_UP: "Park expiry",
  QUOTATION_EXPIRY_W15: "Quote validity",
  ADVANCE_PAYMENT_FOLLOW_UP_W34: "Advance payment follow-up",
  NIGHT_AUDIT_STAY_NIGHT_W37: "Night audit (stay night)",
  ROOM_READINESS_SLA_W23: "Room readiness SLA",
  HANDOFF_ACCEPTANCE_W25: "Handoff acceptance",
  PAYMENT_MILESTONE_W21: "Payment milestone",
};

/** Friendly, human label for a timer. Falls back to the raw code when unmapped. */
export function labelForTimer(t: TimerLike): string {
  const code = t.timerCode || t.timerType || "";
  if (code === "ACKNOWLEDGEMENT_WINDOW_W22") {
    const msg = t.stageContext ? ACK_MESSAGE_BY_STAGE[t.stageContext] : null;
    return msg ? `Awaiting reply · ${msg}` : "Awaiting guest reply";
  }
  return TIMER_LABELS[code] ?? code;
}

/**
 * The live park-expiry timer, if the backend armed one. Parking cancels the short stage-expiry
 * window and arms this long one in its place, so it's the only clock a parked booking is running
 * — worth showing rather than leaving the operator to guess how long a park lasts.
 */
export function findParkTimer<T extends TimerLike & { status?: string }>(timers: T[] | undefined | null): T | null {
  return (
    (timers ?? []).find(
      (t) => (t.timerCode || t.timerType) === "PARKING_FOLLOW_UP" && (t.status ?? "SCHEDULED") === "SCHEDULED",
    ) ?? null
  );
}

/**
 * "in 29d 4h" / "in 3h 12m" / "in 8m" / "due now" — a countdown to an instant, coarse-grained to
 * the two most significant units. `warn` under a day, `crit` under an hour.
 */
export function countdownTo(iso: string, now: number = Date.now()): { text: string; level: "" | "warn" | "crit" } {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return { text: "due now", level: "crit" };
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const text =
    days > 0 ? `in ${days}d ${hours % 24}h` : hours > 0 ? `in ${hours}h ${mins % 60}m` : `in ${Math.max(1, mins)}m`;
  const level: "" | "warn" | "crit" = hours < 1 ? "crit" : days < 1 ? "warn" : "";
  return { text, level };
}

// S1..S9 ordering so we can tell whether a timer's stage is behind the entry's current stage.
const STAGE_INDEX: Record<string, number> = {
  S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6, S7: 7, S8: 8, S9: 9,
};

/**
 * True when this is a per-message acknowledgement window whose stage the entry has already moved
 * past — e.g. the S2 quotation ack still showing while the booking sits at S5. Those windows are
 * moot (progression implies the guest engaged) and are noise in the live feed. Deliberately scoped
 * to ACKNOWLEDGEMENT_WINDOW_W22 only, so genuinely cross-stage timers (night audit, etc.) are never
 * hidden by a naive stage comparison.
 */
export function isPassedStageAckWindow(t: TimerLike, currentStage?: string | null): boolean {
  const code = t.timerCode || t.timerType || "";
  if (code !== "ACKNOWLEDGEMENT_WINDOW_W22") return false;
  if (!currentStage || !t.stageContext) return false;
  const from = STAGE_INDEX[t.stageContext];
  const cur = STAGE_INDEX[currentStage];
  return !!from && !!cur && from < cur;
}
