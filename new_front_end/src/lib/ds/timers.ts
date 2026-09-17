/**
 * What runs out, in the desk's words (FIG 4.6): a plain label naming the thing, never a code.
 * Timers the desk has no reason to watch (the system's own housekeeping) are `null` and never
 * shown — the side panel "says nothing where it has nothing to say" (SS03 §3).
 */
type TimerLike = { timerCode?: string | null; timerType?: string | null; stageContext?: string | null };

const ACK_BY_STAGE: Record<string, string> = {
  S2: "The quotation · answer",
  S3: "The proforma · answer",
  S4: "The confirmation voucher · answer",
  S5: "The pre-arrival message · answer",
  S7: "The interim invoice · answer",
  S8: "The invoice · answer",
  S9: "The invoice · answer",
};

const LABELS: Record<string, string | null> = {
  ENTRY_EXPIRY: "The inquiry lapses",
  QUOTATION_VALIDITY_W15: "Quote valid",
  SPECULATIVE_HOLD_EXPIRY_W2: "Marker ends",
  COMMITTED_HOLD_EXPIRY_W3: "Block ends",
  ADVANCE_PAYMENT_FOLLOW_UP_W34: "Advance follow-up",
  ADVANCE_PROMISE_DEADLINE_W38: "Advance promised by",
  STAY_EXTENSION_HOLD_EXPIRY_W40: "Extra nights held until",
  INTERIM_PAYMENT_REMINDER_W41: "Mid-stay payment due",
  PRE_ARRIVAL_COUNTDOWN_W4: "Arrival window opens",
  NO_SHOW_CUTOFF_W5: "No-show cut-off",
  AWAITING_WRITTEN_CONFIRMATION_W5: "Written confirmation due",
  ROOM_READINESS_SLA_W23: "Room ready by",
  VIP_ARRIVAL_NOTIFICATION_W14: "VIP arrival notice",
  H2_H3_ACCEPTANCE_W25: "Housekeeping to accept",
  H4_ACCEPTANCE_W25: "Pre-checkout handoff to accept",
  HANDOFF_ACCEPTANCE_W25: "Handoff to accept",
  NIGHT_AUDIT_W6: null,
  NIGHT_AUDIT_STAY_NIGHT_W37: "Night audit",
  PAYMENT_FOLLOW_UP_W8: "Payment follow-up",
  POST_CHECKOUT_INSPECTION_W9: "Room inspection window",
  DEFICIENT_RESOLUTION_DEADLINE_W10: "Room fault to be fixed by",
  COMMISSION_RATE_MISSING_W11: "Commission rate missing",
  CREDIT_CEILING_MONITORING_W12: null,
  PAYMENT_MILESTONE_W21: "Payment milestone",
  HOUSEKEEPING_SLA_W24: "Housekeeping by",
  CHECKOUT_TIME_W26: "Checkout time",
  DISPUTE_SLA_W27: "Dispute to be answered by",
  FEEDBACK_SOLICITATION_W28: null,
  EQUIPMENT_RETURN_W29: "Equipment back by",
  PARKING_FOLLOW_UP: "Parked until",
  // The system's own clocks — nothing for the desk to watch.
  STAGE_DWELL_MONITOR: null,
  PROCESSING_LOCK_TTL: null,
  OTA_EMAIL_PARSER_POLL: null,
  QUOTATION_ACK_TRACKER: null,
  AI_AUDIT_SUPPLEMENT_W18: null,
  GUEST_DATA_RETENTION_P18: null,
  LOST_FOUND_RETENTION_W30: null,
  FOM_OVERRIDE_FREQUENCY_W32: null,
};

/** The desk's label for a timer, or null when the desk has no reason to see it. */
export function timerLabel(t: TimerLike): string | null {
  const code = t.timerCode || t.timerType || "";
  if (code === "ACKNOWLEDGEMENT_WINDOW_W22") return (t.stageContext && ACK_BY_STAGE[t.stageContext]) || "Waiting for an answer";
  if (code in LABELS) return LABELS[code];
  return null;
}
