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

// Covers every code the backend timer engine can emit (lib/timer-engine.ts TimerCode union) —
// an unmapped code falls back to its raw name, which is exactly the "cryptic label" bug this
// map exists to prevent. Keep the two lists in step.
const TIMER_LABELS: Record<string, string> = {
  STAGE_DWELL_MONITOR: "Stage dwell monitor",
  PROCESSING_LOCK_TTL: "Processing lock expiry",
  ENTRY_EXPIRY: "Inquiry expiry",
  OTA_EMAIL_PARSER_POLL: "OTA email poll",
  QUOTATION_VALIDITY_W15: "Quote validity",
  QUOTATION_ACK_TRACKER: "Quotation acknowledgement tracker",
  SPECULATIVE_HOLD_EXPIRY_W2: "Speculative hold expiry",
  COMMITTED_HOLD_EXPIRY_W3: "Committed hold expiry",
  ADVANCE_PAYMENT_FOLLOW_UP_W34: "Advance payment follow-up",
  // Armed when the guest promised the remaining advance BEFORE check-in by a given date.
  ADVANCE_PROMISE_DEADLINE_W38: "Advance payment promise",
  PRE_ARRIVAL_COUNTDOWN_W4: "Pre-arrival countdown",
  NO_SHOW_CUTOFF_W5: "No-show cutoff",
  AWAITING_WRITTEN_CONFIRMATION_W5: "Awaiting written confirmation",
  ROOM_READINESS_SLA_W23: "Room readiness SLA",
  VIP_ARRIVAL_NOTIFICATION_W14: "VIP arrival notification",
  H2_H3_ACCEPTANCE_W25: "Check-in handoff acceptance (H2/H3)",
  H4_ACCEPTANCE_W25: "Pre-checkout handoff acceptance (H4)",
  NIGHT_AUDIT_W6: "Night audit",
  NIGHT_AUDIT_STAY_NIGHT_W37: "Night audit (stay night)",
  PAYMENT_FOLLOW_UP_W8: "Post-stay payment follow-up",
  POST_CHECKOUT_INSPECTION_W9: "Post-checkout inspection",
  DEFICIENT_RESOLUTION_DEADLINE_W10: "Deficient-room resolution deadline",
  COMMISSION_RATE_MISSING_W11: "Commission rate missing",
  CREDIT_CEILING_MONITORING_W12: "Credit ceiling monitoring",
  AI_AUDIT_SUPPLEMENT_W18: "AI audit supplement",
  PAYMENT_MILESTONE_W21: "Payment milestone",
  HOUSEKEEPING_SLA_W24: "Housekeeping SLA",
  CHECKOUT_TIME_W26: "Checkout time",
  DISPUTE_SLA_W27: "Dispute SLA",
  FEEDBACK_SOLICITATION_W28: "Feedback solicitation",
  EQUIPMENT_RETURN_W29: "Equipment return",
  GUEST_DATA_RETENTION_P18: "Guest data retention",
  LOST_FOUND_RETENTION_W30: "Lost & found retention",
  FOM_OVERRIDE_FREQUENCY_W32: "FOM override frequency check",
  // Armed on park in place of the short stage-expiry timer: a parked booking still expires, but
  // only after the long park window (expiry.parking.followUpDays, 30d default) — SIG-S1 §3.4.
  PARKING_FOLLOW_UP: "Park expiry",
  // Legacy alias kept for rows created before the W25 codes were split per handoff type.
  HANDOFF_ACCEPTANCE_W25: "Handoff acceptance",
};

/** Friendly, human label for a timer. Falls back to the raw code when unmapped. */
export function labelForTimer(t: TimerLike): string {
  const code = t.timerCode || t.timerType || "";
  if (code === "ACKNOWLEDGEMENT_WINDOW_W22") {
    const msg = t.stageContext ? ACK_MESSAGE_BY_STAGE[t.stageContext] : null;
    // Embed which message we're waiting on, so "Awaiting quotation guest reply" reads clearly
    // instead of a bare "Awaiting guest reply" that's ambiguous when several are armed at once.
    return msg ? `Awaiting ${msg.toLowerCase()} guest reply` : "Awaiting guest reply";
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
