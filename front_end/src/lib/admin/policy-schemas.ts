/**
 * Typed field schemas for known `policy_registry` policy IDs.
 *
 * Every policy carries the universal `enabled: boolean` toggle and an optional `description`.
 * Additional typed parameters per policy live in `fields[]` — the /admin/policies page renders
 * a typed form when a policyId has metadata here, and a JSON textarea fallback otherwise.
 */

export type PolicyFieldSchema =
  | { kind: "number"; key: string; label: string; unit?: string; min?: number; max?: number; step?: number; help?: string }
  | { kind: "text"; key: string; label: string; help?: string }
  | { kind: "boolean"; key: string; label: string; help?: string }
  | { kind: "json"; key: string; label: string; placeholder?: string; help?: string };

export type PolicyKeyMeta = {
  policyId: string;
  policyClass: string;
  title: string;
  description: string;
  /** Which workers / runtime policies consult this row. Shown to the operator for context. */
  consumedBy: string[];
  /** Extra typed fields beyond `enabled` + `description`. */
  fields: PolicyFieldSchema[];
  /** Field defaults used when the user creates a fresh row from the typed form. */
  defaults: Record<string, unknown>;
};

export const REGISTRY_POLICY_KEYS: PolicyKeyMeta[] = [
  {
    policyId: "registry.noShow.graceMinutes",
    policyClass: "CANCELLATION",
    title: "No-show grace minutes",
    description: "How long after expected arrival before the no-show timer fires.",
    consumedBy: ["W4"],
    fields: [
      {
        kind: "number",
        key: "graceMinutes",
        label: "Grace minutes",
        unit: "min",
        min: 0,
        step: 5,
        help: "Falls back to ConfigurationEntry `noShow.cutoffWindowMinutes` when disabled or missing.",
      },
    ],
    defaults: { graceMinutes: 120 },
  },
  {
    policyId: "registry.duplicateInquiry.blockS1Exit",
    policyClass: "DUPLICATE_DETECTION",
    title: "Block S1 exit on open duplicate flag",
    description: "When enabled, an entry with an OPEN duplicate flag cannot leave S1 until the flag is resolved.",
    consumedBy: ["p12"],
    fields: [],
    defaults: {},
  },
  {
    policyId: "registry.shadowInventory.l4Only",
    policyClass: "AVAILABILITY",
    title: "Shadow inventory visible to L4 only",
    description: "When enabled, shadow inventory is masked from operational actors and visible only on the admin console.",
    consumedBy: ["p14"],
    fields: [],
    defaults: {},
  },
  {
    policyId: "registry.holdExpiry.minutes",
    policyClass: "AVAILABILITY",
    title: "S3 committed-hold expiry minutes",
    description: "How long a committed hold remains before W3 expires it. Overrides the legacy ConfigurationEntry `expiry.s3.committedHoldTtlSeconds`.",
    consumedBy: ["s3-hold-service", "W3"],
    fields: [
      {
        kind: "number",
        key: "minutes",
        label: "Hold expiry minutes",
        unit: "min",
        min: 1,
        step: 5,
        help: "Falls back to ConfigurationEntry `expiry.s3.committedHoldTtlSeconds` (in seconds) when disabled or missing.",
      },
    ],
    defaults: { minutes: 60 },
  },
  {
    policyId: "registry.discount.actorCeiling",
    policyClass: "DISCOUNT",
    title: "Per-actor discount ceiling",
    description: "Maximum discount percentage each actor level may apply at S2 quotation. Overrides ConfigurationEntry `discount.fom.maxPercentage` / `discount.gm.maxPercentage`.",
    consumedBy: ["p23"],
    fields: [
      { kind: "number", key: "l1MaxPercent", label: "L1 (front desk) max %", unit: "%", min: 0, max: 100, step: 1 },
      { kind: "number", key: "l2MaxPercent", label: "L2 (FOM) max %", unit: "%", min: 0, max: 100, step: 1 },
      { kind: "number", key: "l3MaxPercent", label: "L3 (GM) max %", unit: "%", min: 0, max: 100, step: 1 },
    ],
    defaults: { l1MaxPercent: 5, l2MaxPercent: 15, l3MaxPercent: 100 },
  },
  {
    policyId: "registry.vipArrivalAck.seconds",
    policyClass: "COMMUNICATION",
    title: "VIP arrival acknowledgement window",
    description: "How long staff have to acknowledge a VIP arrival notification before escalation.",
    consumedBy: ["entry-lifecycle-state-machine"],
    fields: [
      {
        kind: "number",
        key: "seconds",
        label: "Ack window",
        unit: "sec",
        min: 60,
        step: 60,
        help: "Falls back to ConfigurationEntry `acknowledgement.windowPerType.vipArrival` (default 3600) when disabled or missing.",
      },
    ],
    defaults: { seconds: 3600 },
  },
  {
    policyId: "registry.deficientResolution.deadlineHours",
    policyClass: "MAINTENANCE",
    title: "Deficient condition resolution deadline",
    description: "Default hours given to housekeeping/maintenance to resolve a deficient condition before escalation.",
    consumedBy: ["inventory-admin-service"],
    fields: [
      {
        kind: "number",
        key: "hours",
        label: "Deadline",
        unit: "hr",
        min: 1,
        step: 1,
        help: "Falls back to ConfigurationEntry `deficientResolution.deadlineHours` (default 48) when disabled or missing.",
      },
    ],
    defaults: { hours: 48 },
  },
  {
    policyId: "registry.handoffAck.seconds",
    policyClass: "HANDOFF",
    title: "Handoff acknowledgement windows (H2 / H4)",
    description: "SLA windows for FOM acknowledgement of H2 (housekeeping) and H4 (departure) handoffs. Overrides ConfigurationEntry `acknowledgement.windowPerType.h2` / `.h4`.",
    consumedBy: ["handoff-service"],
    fields: [
      { kind: "number", key: "h2Seconds", label: "H2 window", unit: "sec", min: 60, step: 60 },
      { kind: "number", key: "h4Seconds", label: "H4 window", unit: "sec", min: 60, step: 60 },
    ],
    defaults: { h2Seconds: 1800, h4Seconds: 1800 },
  },
  {
    policyId: "registry.fomOverride.frequency",
    policyClass: "DISPUTE",
    title: "FOM override frequency cap (W33)",
    description: "Rolling window and max FOM dispute-gate overrides before W33 sends an ambient GM notice.",
    consumedBy: ["W33"],
    fields: [
      { kind: "number", key: "rollingWindowDays", label: "Rolling window", unit: "days", min: 1, step: 1 },
      { kind: "number", key: "maxFrequency", label: "Max overrides", min: 1, step: 1 },
    ],
    defaults: { rollingWindowDays: 7, maxFrequency: 3 },
  },
  {
    policyId: "registry.s1Expiry.minutes",
    policyClass: "EXPIRY",
    title: "S1 inquiry expiry (W20)",
    description: "How long an unanswered S1 inquiry remains open before W20 expires it.",
    consumedBy: ["s1-entry-service", "W20"],
    fields: [
      {
        kind: "number",
        key: "minutes",
        label: "TTL",
        unit: "min",
        min: 1,
        step: 5,
        help: "Falls back to ConfigurationEntry `expiry.s1.defaultTtlSeconds.DEFAULT` (in seconds) when disabled or missing.",
      },
    ],
    defaults: { minutes: 60 },
  },
  {
    policyId: "registry.s2HoldExpiry.minutes",
    policyClass: "EXPIRY",
    title: "S2 speculative hold TTL (W2)",
    description: "Default duration for a speculative room hold before W2 releases it.",
    consumedBy: ["s2-hold-service", "W2"],
    fields: [
      {
        kind: "number",
        key: "minutes",
        label: "TTL",
        unit: "min",
        min: 1,
        step: 5,
        help: "Falls back to ConfigurationEntry `expiry.s2.speculativeHoldTtlSeconds` (in seconds) when disabled or missing.",
      },
    ],
    defaults: { minutes: 15 },
  },
  {
    policyId: "registry.quotationValidity.days",
    policyClass: "EXPIRY",
    title: "Quotation validity (W15)",
    description: "Default number of days a sent quotation remains valid before W15 expires it.",
    consumedBy: ["s2-quotation-service", "W15"],
    fields: [
      {
        kind: "number",
        key: "days",
        label: "Validity",
        unit: "days",
        min: 1,
        step: 1,
        help: "Operator may also override per-quotation at send time. Falls back to ConfigurationEntry `expiry.s2.quotationValidityDays` when disabled or missing.",
      },
    ],
    defaults: { days: 7 },
  },
  {
    policyId: "registry.advancePaymentFollowUp.windowSeconds",
    policyClass: "PAYMENT",
    title: "Advance payment follow-up (W34)",
    description: "How long after invoice issue W34 fires the first follow-up reminder when payment is outstanding.",
    consumedBy: ["s9-service", "W34"],
    fields: [
      {
        kind: "number",
        key: "seconds",
        label: "Follow-up window",
        unit: "sec",
        min: 60,
        step: 60,
        help: "Falls back to ConfigurationEntry `advancePayment.followUpWindowSeconds` when disabled or missing.",
      },
    ],
    defaults: { seconds: 86400 },
  },
  {
    policyId: "registry.groupDetection.guestCountThreshold",
    policyClass: "GROUP_DETECTION",
    title: "Group detection guest count threshold",
    description:
      "Guest count at and above which an entry is auto-routed to group billing. The include flags below decide which age bands count toward the threshold — so a family of 2 adults + 8 toddlers isn't mistakenly classified as a group.",
    consumedBy: ["s1-entry-service", "p64"],
    fields: [
      {
        kind: "number",
        key: "count",
        label: "Guest count",
        unit: "guests",
        min: 2,
        step: 1,
        help: "Falls back to ConfigurationEntry `groupDetection.guestCountThreshold` (default very high → no auto-group) when disabled or missing.",
      },
      {
        kind: "boolean",
        key: "includeAdults",
        label: "Include adults",
        help: "Count adults (guests declared in the Adults field, plus children aged 11+) toward the threshold. Default: on. Turning off means only child-band guests move the needle — rarely what you want.",
      },
      {
        kind: "boolean",
        key: "includeChildren",
        label: "Include children (6–10)",
        help: "Count pricing-children (ages 6–10 by default) toward the threshold. Default: on. These kids typically have own bed / meal charges so contribute to group complexity.",
      },
      {
        kind: "boolean",
        key: "includeYoungChildren",
        label: "Include young children (0–5)",
        help: "Count young children (ages 0–5 by default) toward the threshold. Default: off. Young children share bedding and eat free, so most hotels don't count them as group-defining.",
      },
    ],
    defaults: {
      count: 6,
      includeAdults: true,
      includeChildren: true,
      includeYoungChildren: false,
    },
  },
  {
    policyId: "registry.groupBooking.advancePaymentBoost",
    policyClass: "GROUP_BILLING",
    title: "Group booking advance payment boost",
    description:
      "For entries auto-classified as GROUP_MASTER at S1, multiply the required advance payment amount by this percentage. Groups typically warrant a higher deposit because the no-show risk on multi-room bookings is larger. Falls back to no boost when disabled.",
    consumedBy: ["s3-payment-service.computeAdvancePaymentEvaluation"],
    fields: [
      {
        kind: "number",
        key: "multiplierPercent",
        label: "Multiplier",
        unit: "%",
        min: 100,
        max: 500,
        step: 10,
        help: "200 = require 2x the DEFAULT advance-payment amount for group bookings. 150 = 1.5x. 100 = no boost (same as disabling the policy).",
      },
    ],
    defaults: { multiplierPercent: 200 },
  },
  {
    policyId: "registry.creditCeiling.tier2Percent",
    policyClass: "CREDIT_CEILING",
    title: "Credit ceiling Tier 2 gate %",
    description: "Outstanding-balance ratio that activates the Tier 2 FOM-acknowledgement gate. Consulted by both the S5 check-in gate (p44) and the S7 charge-posting gate (p45).",
    consumedBy: ["p44", "p45"],
    fields: [
      {
        kind: "number",
        key: "percent",
        label: "Tier 2 threshold",
        unit: "%",
        min: 1,
        max: 100,
        step: 1,
        help: "Outstanding ≥ (ceiling × percent / 100) blocks check-in (p44) and charge posting (p45) until FOM acknowledges. Previously hardcoded at 90%.",
      },
    ],
    defaults: { percent: 90 },
  },
  {
    policyId: "registry.creditCeiling.softGatePercent",
    policyClass: "CREDIT_CEILING",
    title: "Credit ceiling soft-gate %",
    description: "Outstanding-balance ratio above which non-mandatory charges are blocked (mandatory room charges still pass). Previously hardcoded at 100%.",
    consumedBy: ["p45"],
    fields: [
      {
        kind: "number",
        key: "percent",
        label: "Soft-gate threshold",
        unit: "%",
        min: 50,
        max: 200,
        step: 1,
        help: "Set above 100 to allow over-ceiling charges; set below 100 to block earlier.",
      },
    ],
    defaults: { percent: 100 },
  },
  {
    policyId: "registry.creditCeiling.advisoryThresholds",
    policyClass: "CREDIT_CEILING",
    title: "Credit ceiling advisory thresholds",
    description: "Percentages at which W12 advisory alerts (not gates) are recorded as the folio outstanding approaches the credit ceiling.",
    consumedBy: ["s7-folio-lines-service", "W12"],
    fields: [
      { kind: "number", key: "tier1Percent", label: "Tier 1 advisory", unit: "%", min: 1, max: 100, step: 1 },
      { kind: "number", key: "tier2Percent", label: "Tier 2 advisory", unit: "%", min: 1, max: 100, step: 1 },
    ],
    defaults: { tier1Percent: 75, tier2Percent: 90 },
  },
  {
    policyId: "registry.vip.notificationRoutingPerTier",
    policyClass: "VIP_NOTIFICATION",
    title: "VIP arrival routing per tier",
    description: "Per-VIP-tier list of roles that must receive the arrival notification at S5→S6 transition. SIG-S6 §9 — blocking for S6_READINESS.",
    consumedBy: ["entry-lifecycle-state-machine", "vip-arrival-notification-service"],
    fields: [
      {
        kind: "json",
        key: "tiers",
        label: "Tier → roles map",
        placeholder: '{\n  "VIP1": ["FOM", "GM"],\n  "VIP2": ["FOM"],\n  "DEFAULT": ["FOM", "GM"]\n}',
        help: "Object whose keys are VIP tier codes and whose values are arrays of role codes (e.g. FOM, GM). DEFAULT is used when an entry's tier isn't listed. Falls back to ConfigurationEntry `vipNotification.routingPerTier` when disabled or missing.",
      },
    ],
    defaults: { tiers: { DEFAULT: ["FOM", "GM"] } },
  },
  {
    policyId: "registry.lostFound.retentionWarning.days",
    policyClass: "RETENTION",
    title: "Lost & Found retention warning offset",
    description: "Days before a Lost & Found item's retention expiry that W30 emits the approaching-expiry trace.",
    consumedBy: ["W30"],
    fields: [
      {
        kind: "number",
        key: "days",
        label: "Warning offset",
        unit: "days",
        min: 1,
        step: 1,
        help: "Falls back to ConfigurationEntry `lostFound.retention.warningOffsetDays` (default 3) when disabled or missing.",
      },
    ],
    defaults: { days: 3 },
  },
  // ---- Child policy (Legphel-Child-Policy.md) -------------------------------------------------
  {
    policyId: "registry.child.ageBands",
    policyClass: "PRICING",
    title: "Child age bands",
    description:
      "Age cutoffs used to classify each guest. Young child = 0..youngChildMaxAge; child = (youngChildMaxAge+1)..childMaxAge; adult = childMaxAge+1 and above.",
    consumedBy: ["child-policy-service", "capacity-validation-service", "pricing engine"],
    fields: [
      { kind: "number", key: "youngChildMaxAge", label: "Young-child max age (inclusive)", unit: "yrs", min: 0, max: 17, step: 1, help: "Defaults to 5 — children aged 0–5 are 'young child'." },
      { kind: "number", key: "childMaxAge", label: "Child max age (inclusive)", unit: "yrs", min: 0, max: 17, step: 1, help: "Defaults to 10 — children aged (youngChildMaxAge+1)–10 are 'child'; 11+ are adult." },
    ],
    defaults: { youngChildMaxAge: 5, childMaxAge: 10 },
  },
  {
    policyId: "registry.child.mealPricing",
    policyClass: "PRICING",
    title: "Child meal pricing",
    description:
      "Percentage of the adult meal rate applied per band. Applies to the meal component of a plan or package, not the room rate.",
    consumedBy: ["pricing engine"],
    fields: [
      { kind: "number", key: "youngChildPercent", label: "Young-child %", unit: "%", min: 0, max: 100, step: 5, help: "Defaults to 0 (free)." },
      { kind: "number", key: "childPercent", label: "Child %", unit: "%", min: 0, max: 100, step: 5, help: "Defaults to 70 (70% of adult)." },
      { kind: "number", key: "adultPercent", label: "Adult %", unit: "%", min: 0, max: 100, step: 5, help: "Defaults to 100 (full rate). Rarely changed." },
    ],
    defaults: { youngChildPercent: 0, childPercent: 70, adultPercent: 100 },
  },
  {
    policyId: "registry.child.separateBedCharge",
    policyClass: "PRICING",
    title: "Separate-bed charge for a child",
    description:
      "Charge applied when a child requests a separate bed instead of sharing the parents' bedding. basis = FLAT (currency amount) or PERCENT_OF_ROOM (% of room base rate). Open decision per the child policy doc — start disabled until the hotel sets a value.",
    consumedBy: ["pricing engine"],
    fields: [
      { kind: "text", key: "basis", label: "Basis", help: "FLAT or PERCENT_OF_ROOM" },
      { kind: "number", key: "amount", label: "Amount", min: 0, step: 1, help: "Flat currency amount when basis=FLAT, percent when basis=PERCENT_OF_ROOM." },
      { kind: "text", key: "currency", label: "Currency", help: "Only used when basis=FLAT. Defaults to BTN." },
    ],
    defaults: { basis: "FLAT", amount: 0, currency: "BTN" },
  },
  {
    policyId: "registry.child.unaccompaniedMinorMinAge",
    policyClass: "COMPLIANCE",
    title: "Unaccompanied-minor minimum age",
    description: "A guest younger than this cannot book or occupy a room without a responsible adult. Blocks S1 intake.",
    consumedBy: ["capacity-validation-service"],
    fields: [
      { kind: "number", key: "minimumAge", label: "Minimum age", unit: "yrs", min: 0, max: 25, step: 1, help: "Defaults to 18." },
    ],
    defaults: { minimumAge: 18 },
  },
  {
    policyId: "registry.child.adultToChildRatio",
    policyClass: "OCCUPANCY",
    title: "Adult-to-child ratio cap",
    description: "Optional cap: at most maxChildrenPerAdult children for each accompanying adult. Disable to skip.",
    consumedBy: ["capacity-validation-service"],
    fields: [
      { kind: "number", key: "maxChildrenPerAdult", label: "Max children per adult", min: 1, step: 1 },
    ],
    defaults: { maxChildrenPerAdult: 3 },
  },
];

export function getPolicyMeta(policyId: string): PolicyKeyMeta | undefined {
  return REGISTRY_POLICY_KEYS.find((p) => p.policyId === policyId);
}
