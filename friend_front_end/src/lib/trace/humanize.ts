export type TraceEvent = {
  id: string;
  eventType: string;
  actorId: string;
  actorLevel: string;
  actorName?: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: unknown;
  timestamp: string;
  stageContext: string | null;
  segmentContext: string | null;
  correlationId: string | null;
  inquiryId: string | null;
  entryId: string | null;
};

export type TraceTone = "info" | "success" | "warning" | "critical";

export type HumanTrace = {
  category: string;
  title: string;
  detail: string | null;
  tone: TraceTone;
  actor: string;
  actorLevel: string;
  whenRelative: string;
  whenAbsolute: string;
  stage: string | null;
};

// Friendly names for the leading domain segment of an eventType.
const CATEGORY_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  ENTRY: "Booking",
  INQUIRY: "Inquiry",
  S1: "Stage 1",
  S2: "Stage 2",
  S3: "Stage 3",
  S4: "Stage 4",
  S5: "Stage 5",
  S6: "Stage 6",
  S7: "Stage 7",
  S8: "Stage 8",
  S9: "Stage 9",
  STAGE_DWELL: "Stage timing",
  NO_SHOW: "No-show",
  NO_SHOW_CUTOFF: "No-show",
  HANDOFF: "Handoff",
  CHECK_IN: "Check-in",
  CHECK_IN_COMPLETE: "Check-in",
  WALK_IN: "Walk-in",
  NIGHT_AUDIT: "Night audit",
  NIGHT_AUDIT_STAY_NIGHT: "Night audit",
  PAYMENT_FOLLOW_UP: "Payment",
  PAYMENT_MILESTONE: "Payment",
  ADVANCE_PAYMENT: "Advance payment",
  COMMITTED_HOLD: "Hold",
  SPECULATIVE_HOLD: "Hold",
  CREDIT_CEILING_THRESHOLD: "Credit ceiling",
  COMMISSION_DUE: "Commission",
  DISPUTE_SLA: "Dispute",
  HOUSEKEEPING_SLA: "Housekeeping",
  NOTIFICATION: "Notification",
  FEEDBACK: "Feedback",
  LOST_FOUND: "Lost & found",
  EQUIPMENT_RETURN: "Equipment",
  OTA_EMAIL: "OTA email",
  OTA_EMAIL_PARSER_POLL: "OTA email",
  PRE_ARRIVAL: "Pre-arrival",
  PROCESSING_LOCK: "Processing lock",
  DEFICIENT_RESOLUTION_DEADLINE: "Room condition",
  GUEST_DATA_RETENTION: "Guest data",
  FOM_OVERRIDE_FREQUENCY: "FOM override",
  CHECKOUT_TIME: "Checkout",
  POST_CHECKOUT_INSPECTION: "Inspection",
  REENTRY: "Re-entry",
  CONFERENCE: "Conference",
  MULTI_BOOKING: "Multi-booking",
  TIMER_MANAGEMENT: "Timers",
  AI_AUDIT_SUPPLEMENT: "AI audit",
  LOGIN: "Session",
  PIN_SWITCH: "Session",
  MANUAL_LOCK: "Session",
  HARD_LOGOUT: "Session",
};

const CRITICAL = ["BREACHED", "EXCEEDED", "EXPIRED", "ESCALATED", "CRITICAL", "FAILED", "REJECTION", "REJECTED", "CANCELLED"];
const WARNING = ["WARNING", "SKIP", "SKIPPED", "MISSING", "APPROACHING", "NOOP", "REENTRY", "ALERTED", "DEFERRAL", "PARTIAL"];
const SUCCESS = ["CREATED", "COMPLETE", "COMPLETED", "CLOSED", "VERIFIED", "ACKNOWLEDGED", "FULFILLED", "ISSUED", "RECEIVED", "SENT", "ACTIVATED", "FINALISED", "RESOLVED", "CONFIRMED", "SAVED", "DISPATCHED"];

function titleCaseWords(snake: string): string {
  const words = snake.replace(/\./g, " ").replace(/_/g, " ").trim().toLowerCase().split(/\s+/);
  if (words.length === 0) return snake;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function toneFor(eventType: string): TraceTone {
  const upper = eventType.toUpperCase();
  if (CRITICAL.some((k) => upper.includes(k))) return "critical";
  if (WARNING.some((k) => upper.includes(k))) return "warning";
  if (SUCCESS.some((k) => upper.includes(k))) return "success";
  return "info";
}

const STAGE_NAMES: Record<string, string> = {
  S1: "Inquiry", S2: "Quotation", S3: "Reservation", S4: "Confirmation", S5: "Arrival",
  S6: "In-house", S7: "Stay", S8: "Checkout", S9: "Post-stay",
};

function friendlyStage(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return STAGE_NAMES[stage] ? `${stage} · ${STAGE_NAMES[stage]}` : stage;
}

// Payload keys worth surfacing as a one-line summary, in priority order.
const SUMMARY_KEYS = [
  "configKey", "name", "templateKey", "policyId", "blockingCondition", "reason",
  "fromStage", "toStage", "vipTier", "handoffType", "version", "modeKey", "message",
];

function buildDetail(payload: unknown, eventType: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // Stage transitions read best as "from → to".
  if (p.fromStage || p.toStage) {
    const from = friendlyStage((p.fromStage as string) ?? null);
    const to = friendlyStage((p.toStage as string) ?? null);
    if (from && to) return `${from}  →  ${to}`;
  }

  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const v = p[key];
    if (v === undefined || v === null || v === "" || typeof v === "object") continue;
    parts.push(`${titleCaseWords(key)}: ${String(v)}`);
    if (parts.length >= 3) break;
  }
  if (parts.length > 0) return parts.join(" · ");

  // Admin config changes: show value change when scalar.
  if (eventType.startsWith("ADMIN.") && p.configKey) {
    return `${String(p.configKey)}`;
  }
  return null;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((now.getTime() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} yr ago`;
}

export function humanizeTrace(event: TraceEvent, now?: Date): HumanTrace {
  const [domain, ...rest] = event.eventType.split(".");
  const category = CATEGORY_LABELS[domain] ?? titleCaseWords(domain);
  const action = rest.length > 0 ? titleCaseWords(rest.join(" ")) : titleCaseWords(domain);
  const title = rest.length > 0 ? action : titleCaseWords(event.eventType);
  const ts = new Date(event.timestamp);

  return {
    category,
    title,
    detail: buildDetail(event.payload, event.eventType),
    tone: toneFor(event.eventType),
    actor: event.actorName ?? event.actorId,
    actorLevel: event.actorLevel,
    whenRelative: relativeTime(event.timestamp, now),
    whenAbsolute: ts.toLocaleString(),
    stage: friendlyStage(event.stageContext),
  };
}
