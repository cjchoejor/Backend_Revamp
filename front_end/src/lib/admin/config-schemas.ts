/** Known configuration keys with human-friendly form metadata (ACIG ConfigurationEntry). */

export type ConfigSchema =
  | { kind: "number"; label: string; unit?: string; min?: number; step?: number; help?: string }
  | { kind: "percentage"; label: string; min?: number; max?: number; step?: number; help?: string }
  | { kind: "text"; label: string; help?: string }
  | { kind: "cron"; label: string; help?: string }
  | { kind: "seconds"; label: string; help?: string }
  | { kind: "hours"; label: string; help?: string }
  | { kind: "days"; label: string; help?: string }
  | { kind: "day-list"; label: string; help?: string }
  | { kind: "money"; label: string; currencyField?: boolean; help?: string }
  | { kind: "record-seconds"; label: string; fields: { key: string; label: string }[]; help?: string }
  | { kind: "record-percent"; label: string; fields: { key: string; label: string }[]; help?: string }
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
  /** Optional — when missing the SmartConfigEditor (JSON-aware fallback) renders. */
  schema?: ConfigSchema;
};

/**
 * Spec-strict subset. Only keys owned by WorkflowConfigurationService or the generic
 * ConfigurationService live here. Domain-owned keys (acknowledgement.windowPerType,
 * advancePayment.*, processingLock.*, nightAudit.*, housekeeping.*, etc.) now surface on their
 * owner's page; their typed schemas are preserved in `DOMAIN_OWNED_TYPED_SCHEMAS` below so the
 * `getConfigSchema()` lookup still finds them.
 */
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
    key: "stageDwell.thresholds",
    title: "Stage dwell warnings",
    description: "Warning / critical / escalation seconds per stage and entry state.",
    worker: "Dwell monitors",
    schema: { kind: "stage-dwell", label: "Stage dwell thresholds" },
  },
  {
    key: "deficientResolution.deadlineHours",
    title: "Deficient condition resolution deadline (W10)",
    description: "Default hours given to housekeeping/maintenance to resolve a deficient condition before escalation.",
    worker: "W10",
    schema: { kind: "hours", label: "Deadline (hours)", help: "May also be overridden via the Policy Registry (registry.deficientResolution.deadlineHours)." },
  },
  {
    key: "lostFound.retention.warningOffsetDays",
    title: "Lost & Found retention warning offset (W30)",
    description: "Days before retention expiry that W30 emits the approaching-expiry trace.",
    worker: "W30",
    schema: { kind: "days", label: "Warning offset (days)", help: "May also be overridden via the Policy Registry (registry.lostFound.retentionWarning.days)." },
  },
];

/**
 * Typed-form metadata for keys that USED to live on /admin/timers-workers but per ACIG ownership
 * belong on a domain-specific page. The key list controlling sidebar visibility moved; the typed
 * schema stays accessible via `getConfigSchema()` so each owner's page renders the rich editor.
 */
export const DOMAIN_OWNED_TYPED_SCHEMAS: ConfigKeyMeta[] = [
  // OTA-owned
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
];

/**
 * Operational schedule keys that need typed editors but should NOT appear on /admin/timers-workers
 * (they're owned by OperationalScheduleService and write through that domain endpoint).
 */
export const OPERATIONAL_CONFIG_SCHEMAS: ConfigKeyMeta[] = [
  {
    key: "checkout.cutoffTime",
    title: "Checkout cutoff time",
    description: "Time of day (24-hour, hotel-local) after which the late-checkout escalation timer fires.",
    schema: {
      kind: "text",
      label: "Cutoff time (HH:MM)",
      help: "Example: 12:00 = noon hotel-local. Use 24-hour format.",
    },
  },
  {
    key: "billing.salesTaxRate",
    title: "GST rate",
    description: "Goods and Services Tax applied to every guest folio. Enter the percentage (e.g. 5 for 5%, 2.5 for 2.5%); stored as a decimal internally.",
    schema: {
      kind: "percentage",
      label: "GST rate",
      min: 0,
      max: 100,
      step: 0.5,
      help: "Read at S2 quotation, S3 PI, S4 confirmation, S7 charge posting, S8/S9 invoice. Compound: applied to subtotal + service charge.",
    },
  },
  {
    key: "billing.serviceChargeRate",
    title: "Service charge rate",
    description: "Service charge applied to the room subtotal before GST is calculated. Enter the percentage (e.g. 10 for 10%).",
    schema: {
      kind: "percentage",
      label: "Service charge rate",
      min: 0,
      max: 100,
      step: 0.5,
      help: "Applied to subtotal only; GST is then applied to subtotal + service charge.",
    },
  },
];

/**
 * Description-only entries for keys that don't yet have a typed form. The SmartConfigEditor
 * renders the JSON value; this map gives operators a one-sentence-per-key explanation of what
 * the setting controls and where it's read at runtime. Sourced from SIG-S1..S9 + ACIG §9.
 */
export const INFO_ONLY_CONFIG_DESCRIPTIONS: ConfigKeyMeta[] = [
  // Commercial (CommercialThresholdService)
  {
    key: "discount.fom.maxPercentage",
    title: "Front-desk discount ceiling",
    description:
      "Maximum discount % an L1 actor (Front Desk) may apply at S2 quotation before escalation to FOM. SIG-S2 P23 — actor authority bands.",
  },
  {
    key: "discount.gm.maxPercentage",
    title: "FOM discount ceiling",
    description:
      "Maximum discount % an L2 actor (FOM) may apply at S2 quotation before escalation to GM. SIG-S2 P23 — actor authority bands.",
  },
  {
    key: "creditCeiling.clientTier.thresholds",
    title: "Credit ceiling by client tier",
    description:
      "Per-tier credit-ceiling amounts (STANDARD / PREFERRED / CAUTION / RESTRICTED) used at S3 hold + S5 check-in. SIG-S5 P44.",
  },
  {
    key: "creditCeiling.proximityThresholds",
    title: "Credit ceiling proximity",
    description:
      "Percentages (e.g. 75% / 90%) at which W12 advisory events fire as folio outstanding approaches the credit ceiling. SIG-S7 §5.",
  },
  {
    key: "foc.configuration",
    title: "FOC (free-of-charge) configuration",
    description:
      "Per-rate-plan FOC eligibility, seasonality restrictions, and group thresholds. Consulted at S2 quotation and S4 confirmation. SIG-S2 P19.",
  },
  {
    key: "overbooking.maxAllowedRooms",
    title: "Overbooking ceiling",
    description: "Maximum rooms that may be overbooked across the property on any given night. Enforced at S4 confirmation. SIG-S4 P41.",
  },
  {
    key: "confirmation.authorityThresholds",
    title: "Confirmation authority thresholds",
    description:
      "Nightly-rate bands above which S4 confirmation requires FOM or GM authority. SIG-S4 P40 — high-value confirmation authority.",
  },
  {
    key: "speculativeHold.placementThresholds",
    title: "Speculative hold thresholds",
    description: "Rooms-requested bands controlling who can place a speculative hold at S2 (L1 vs. FOM-approved). SIG-S2 §6.4.",
  },
  {
    key: "writeOff.authority.thresholds",
    title: "Write-off authority",
    description: "Amount bands defining who (FOM / GM) may write off an outstanding folio balance at S9 closure. SIG-S9 §6.6.",
  },

  // Cancellation
  {
    key: "cancellation.policyTiers",
    title: "Cancellation penalty tiers",
    description:
      "Default penalty ladder by days-before-arrival (e.g. 7 days = 0%, 3 days = 50%, same-day = 100%). Used as a fallback when an entry has no bespoke cancellation policy attached. SIG-S5 P35.",
  },

  // Financial
  {
    key: "advancePayment.thresholds",
    title: "Advance payment thresholds",
    description:
      "Required advance amount per booking shape (DEFAULT, group, OTA, etc.). Determines whether S4 confirmation is gated on payment receipt. SIG-S3 §6.4.",
  },
  {
    key: "proformaInvoice.templates",
    title: "Proforma invoice templates",
    description:
      "Per-channel / per-billing-model PI template keys used at S3 PI generation. Operators ship one template per (channel × billing-model) combination.",
  },
  {
    key: "invoice.templates",
    title: "Invoice templates",
    description: "Invoice template keys mapped per use type / billing model. Read at S9 final invoice generation.",
  },
  {
    key: "damage.rateList",
    title: "Damage rate list",
    description: "Per-item damage charge amounts. Looked up at S7 when posting damage charges to a folio.",
  },

  // Operational schedule
  {
    key: "nightAudit.expectedChargesRules",
    title: "Expected charges rules",
    description:
      "Per-line-type expected daily amounts the night-audit worker compares against actuals. Anomaly when actuals diverge by configured tolerance. SIG-S8 W37.",
  },
  {
    key: "nightAudit.expectedDailyFAndBCharge",
    title: "Expected daily F&B charge",
    description: "Per-occupied-room nightly F&B baseline. Drives the F&B variance flag during night audit.",
  },
  {
    key: "roomAssignment.priorityRules",
    title: "Room assignment priority",
    description:
      "Ordered rule set the auto-assignment service uses at S5 pre-arrival (e.g. floor preference, accessibility, VIP tier). SIG-S5 W23.",
  },

  // OTA
  {
    key: "ota.sourceFlagConfig",
    title: "OTA source flag config",
    description: "Per-OTA-source toggle for whether bookings from that channel are marked otaSource=true. Affects shadow inventory and S1 visibility.",
  },
  {
    key: "ota.conflictTriggerRules",
    title: "OTA conflict trigger rules",
    description: "Rules that classify an inbound OTA booking event as a conflict (e.g. double-booking) requiring manual reconciliation.",
  },
  {
    key: "noShow.cutoffMinutes",
    title: "No-show cutoff minutes (OTA override)",
    description: "OTA-channel-specific cutoff minutes that override the global noShow.cutoffWindowMinutes. SIG-S5 W5.",
  },
  {
    key: "noShow.penaltyStructure",
    title: "No-show penalty structure",
    description: "Per-channel no-show penalty rules (full charge, percent of first night, etc.) applied at no-show finalisation.",
  },

  // AI Agent
  {
    key: "ai.agentConfig",
    title: "AI agent configuration",
    description: "Per-channel AI agent settings (model, persona, allowed actions, escalation rules). Used by the AI drafting pipeline.",
  },
  {
    key: "voiceNote.reviewSlaPerChannel",
    title: "Voice note review SLA",
    description: "Per-channel SLA (seconds) for L1 review of AI-transcribed voice notes before they're treated as actioned. SIG-S6.",
  },
  {
    key: "voiceNote.escalationRouting",
    title: "Voice note escalation routing",
    description: "Where unreviewed voice notes escalate to once the SLA expires (e.g. FOM queue).",
  },

  // Communication
  {
    key: "communication.channels",
    title: "Communication channels",
    description:
      "Configured outbound channels (Email, WhatsApp, SMS) with credentials and templates per channel. Empty until you add at least one. ACIG §6.2.20.",
  },

  // Post-stay
  {
    key: "feedback.platformLinks",
    title: "Review platform links",
    description: "URLs to the hotel's TripAdvisor / Google / Booking.com review pages. Included in feedback solicitation emails. SIG-S9 W28.",
  },
  {
    key: "government.submissionConfig",
    title: "Government portal submission",
    description: "Endpoint and credentials for the local government guest-registration portal. Drives the W29 submission worker. SIG-S9 §7.",
  },
  {
    key: "commission.calculationBasis",
    title: "Commission calculation basis",
    description: "Per-agent / per-channel commission rules (basis amount, percentage, payment terms). Computed at S9 closure for booking agents.",
  },
  {
    key: "identity.documentTypes",
    title: "Identity document types",
    description:
      "Catalogue of accepted ID document types (Passport, National ID, …). Each entry: { documentTypeCode, documentTypeName, isActive }. NOT for capturing guest attributes like gender — those belong on GuestProfile.",
  },
  {
    key: "identity.retentionPeriodDays",
    title: "Identity document retention",
    description:
      "Retention period in days per document type before W30 purges the stored copy. Compliance with local data-protection rules.",
  },

  // Generic
  {
    key: "deficientCondition.categories",
    title: "Deficient condition categories",
    description:
      "Catalogue of categories an operator can pick when marking a room deficient (HOUSEKEEPING, MAINTENANCE, SOFT_FURNISHING, OTHER). SIG-S1 P02.",
  },
  {
    key: "availability.bookablePhysicalStates",
    title: "Bookable physical states",
    description:
      "Whitelist of Room.physicalState values eligible to appear in S1 availability results (typically just `FREE`). SIG-S1 §5.1.",
  },
  {
    key: "availability.shadowInventory.visibilityRules",
    title: "Shadow inventory visibility",
    description: "Per actor-level rules controlling whether shadow inventory rooms appear in S1 availability search results. SIG-S1 P14.",
  },
  {
    key: "paymentMilestone.scheduleTemplates",
    title: "Payment milestone templates",
    description:
      "Per-billing-model schedule of payment milestones (e.g. 30% deposit, 50% on confirmation, balance on arrival). Drives the S3/S4 payment milestone scheduler.",
  },
  {
    key: "paymentMilestone.warningOffsetDays",
    title: "Payment milestone warning offset",
    description: "Days before a scheduled milestone that the system warns staff if it remains unpaid.",
  },
  {
    key: "ai.confidenceThreshold.autoApprove",
    title: "AI auto-approve threshold",
    description:
      "Confidence score above which AI-generated drafts are dispatched without human review. Below this, drafts queue for L1/L2 approval.",
  },
  {
    key: "ai.correctionLog.maximumSize",
    title: "AI correction log size",
    description: "How many recent human corrections to AI drafts the system keeps for prompt-tuning / audit. Older entries are pruned.",
  },
];

export function getConfigSchema(configKey: string): ConfigKeyMeta | undefined {
  return (
    TIMER_WORKER_CONFIG_KEYS.find((k) => k.key === configKey) ??
    DOMAIN_OWNED_TYPED_SCHEMAS.find((k) => k.key === configKey) ??
    OPERATIONAL_CONFIG_SCHEMAS.find((k) => k.key === configKey) ??
    INFO_ONLY_CONFIG_DESCRIPTIONS.find((k) => k.key === configKey)
  );
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
