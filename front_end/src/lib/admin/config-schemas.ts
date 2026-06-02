/** Known configuration keys with human-friendly form metadata (ACIG ConfigurationEntry). */

export type ConfigSchema =
  | { kind: "number"; label: string; unit?: string; min?: number; step?: number; help?: string }
  | { kind: "text"; label: string; help?: string }
  | { kind: "cron"; label: string; help?: string }
  | { kind: "seconds"; label: string; help?: string }
  | { kind: "hours"; label: string; help?: string }
  | { kind: "days"; label: string; help?: string }
  | { kind: "day-list"; label: string; help?: string }
  | { kind: "money"; label: string; currencyField?: boolean; help?: string }
  | { kind: "record-seconds"; label: string; fields: { key: string; label: string }[]; help?: string }
  | { kind: "dispute-sla"; label: string }
  | { kind: "night-audit-schedule"; label: string }
  | { kind: "fom-override-frequency"; label: string }
  | { kind: "stage-dwell"; label: string }
  | { kind: "ack-windows"; label: string }
  | { kind: "processing-lock-ttl"; label: string };

export type ConfigKeyMeta = {
  key: string;
  title: string;
  description: string;
  worker?: string;
  schema: ConfigSchema;
};

export const TIMER_WORKER_CONFIG_KEYS: ConfigKeyMeta[] = [
  {
    key: "expiry.s1.defaultTtlSeconds",
    title: "Inquiry expiry (S1)",
    description: "How long an S1 inquiry may remain open before W20 expiry fires.",
    worker: "W20",
    schema: { kind: "record-seconds", label: "TTL by type", fields: [{ key: "DEFAULT", label: "Default (seconds)" }] },
  },
  {
    key: "expiry.s2.speculativeHoldTtlSeconds",
    title: "Speculative hold TTL (S2)",
    description: "Default duration for speculative room holds.",
    worker: "W2",
    schema: { kind: "seconds", label: "TTL (seconds)", help: "900 = 15 minutes" },
  },
  {
    key: "expiry.s2.quotationValidityDays",
    title: "Quotation validity",
    description: "Days a quotation remains valid.",
    worker: "W15",
    schema: { kind: "days", label: "Validity (days)" },
  },
  {
    key: "expiry.s3.committedHoldTtlSeconds",
    title: "Committed hold TTL (S3)",
    description: "How long a committed hold stays before expiry.",
    worker: "W3",
    schema: { kind: "seconds", label: "TTL (seconds)" },
  },
  {
    key: "ota_email_poll_interval_seconds",
    title: "OTA email poll interval",
    description: "How often the system checks the OTA inbox.",
    worker: "W7",
    schema: { kind: "seconds", label: "Poll every (seconds)", help: "300 = 5 minutes" },
  },
  {
    key: "processingLock.ttl.perChannel",
    title: "Processing lock TTL",
    description: "Max time a channel lock may be held before W16 releases it.",
    worker: "W16",
    schema: { kind: "processing-lock-ttl", label: "Per-channel TTL (seconds)" },
  },
  {
    key: "advancePayment.followUpWindowSeconds",
    title: "Advance payment follow-up (tier 1)",
    description: "First reminder window after advance payment is due.",
    worker: "W34",
    schema: { kind: "seconds", label: "Window (seconds)" },
  },
  {
    key: "advancePayment.escalationWindowSeconds",
    title: "Advance payment escalation (tier 2)",
    description: "Second escalation window; must be greater than tier 1.",
    worker: "W34",
    schema: { kind: "seconds", label: "Window (seconds)" },
  },
  {
    key: "payment.followUp.ttlDays",
    title: "Post-stay payment follow-up TTL",
    description: "Default days for W8 payment follow-up timers after checkout.",
    worker: "W8",
    schema: { kind: "days", label: "TTL (days)" },
  },
  {
    key: "payment.followUp.intervals",
    title: "Payment follow-up schedule",
    description: "Days after checkout when follow-up reminders are sent (S9).",
    worker: "W8",
    schema: { kind: "day-list", label: "Reminder days (comma-separated)" },
  },
  {
    key: "acknowledgement.windowPerType",
    title: "Acknowledgement windows",
    description: "How long guests have to acknowledge outbound communications (W22).",
    worker: "W22",
    schema: { kind: "ack-windows", label: "Per communication type" },
  },
  {
    key: "dispute.sla",
    title: "Dispute SLA timers",
    description: "First response and resolution reminder offsets for W27.",
    worker: "W27",
    schema: { kind: "dispute-sla", label: "Dispute SLA" },
  },
  {
    key: "housekeeping.sla.windowMinutes",
    title: "Housekeeping SLA window",
    description: "Minutes allowed for housekeeping turnaround (W24).",
    worker: "W24",
    schema: { kind: "number", label: "Window (minutes)", min: 1 },
  },
  {
    key: "inspection.postCheckout.windowHours",
    title: "Post-checkout inspection window",
    description: "Hours after checkout deferral before W9 inspection window expires.",
    worker: "W9",
    schema: { kind: "hours", label: "Window (hours)" },
  },
  {
    key: "room.readiness.slaWindow",
    title: "Room readiness SLA",
    description: "Seconds allowed for room readiness before W23 escalation.",
    worker: "W23",
    schema: { kind: "seconds", label: "SLA (seconds)" },
  },
  {
    key: "noShow.cutoffWindowMinutes",
    title: "No-show cutoff",
    description: "Minutes after expected arrival before no-show treatment (W5).",
    worker: "W5",
    schema: { kind: "number", label: "Cutoff (minutes)", min: 0 },
  },
  {
    key: "nightAudit.scheduleTime",
    title: "Night audit cron",
    description: "When the nightly audit job runs (cron expression, UTC).",
    worker: "Night audit",
    schema: { kind: "cron", label: "Cron schedule", help: "Example: 0 2 * * * = 02:00 UTC daily" },
  },
  {
    key: "nightAudit.schedule",
    title: "Stay-night reminder hour",
    description: "UTC hour for per stay-night countdown jobs (W37).",
    worker: "W37",
    schema: { kind: "night-audit-schedule", label: "Schedule" },
  },
  {
    key: "fomOverride.frequency",
    title: "FOM override frequency cap",
    description: "Rolling window limits for FOM overrides (W33).",
    worker: "W33",
    schema: { kind: "fom-override-frequency", label: "Override limits" },
  },
  {
    key: "stageDwell.thresholds",
    title: "Stage dwell warnings",
    description: "Warning / critical / escalation seconds per stage and entry state.",
    worker: "Dwell monitors",
    schema: { kind: "stage-dwell", label: "Stage dwell thresholds" },
  },
];

export function getConfigSchema(configKey: string): ConfigKeyMeta | undefined {
  return TIMER_WORKER_CONFIG_KEYS.find((k) => k.key === configKey);
}

export const STAGES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"] as const;
export const ENTRY_STATES = ["ACTIVE", "IDLE", "PARKED"] as const;
export const DWELL_LEVELS = ["warning", "critical", "escalation"] as const;

export type StageDwellValue = Record<
  string,
  Record<string, { warning: number; critical: number; escalation: number }>
>;

export const ACK_WINDOW_LABELS: Record<string, string> = {
  quotation: "Quotation",
  pi: "Proforma invoice",
  voucher: "Voucher",
  preArrival: "Pre-arrival",
  amendment: "Amendment",
  cancellation: "Cancellation",
  invoice: "Invoice",
  h2: "Handoff H2",
  h3: "Handoff H3",
  vipArrival: "VIP arrival",
};

/** Runtime policy modules in code (not editable via Policy Registry). */
export const CODE_POLICY_MODULES = [
  { id: "P01", name: "Availability & stage gates", count: 28 },
  { id: "P07", name: "Quotation lifecycle", count: 4 },
  { id: "P16", name: "Guest identity", count: 6 },
  { id: "P19", name: "Rate plan resolution", count: 4 },
  { id: "P25", name: "Speculative holds", count: 3 },
  { id: "P31", name: "Folio & billing", count: 8 },
  { id: "P54", name: "Dispute gates", count: 2 },
] as const;
