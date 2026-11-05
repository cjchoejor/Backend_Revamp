/**
 * What every setting and house rule is called, what it means, and the form it is edited with
 * (2026-11-02). Plain words on screen; the stored name is behind the "?" for whoever needs it. A form
 * only names fields the backend reads, in the unit the backend reads them in. `unused` says so where
 * nothing reads the setting yet.
 */
import { durationInWords } from "@/components/admin/duration-input";
import { timeInWords } from "@/components/ds/date-input";
import { asRec, type Opt, type Rec, type SField } from "@/lib/admin/setting-fields";

export type SettingDef = {
  key: string;
  title: string;
  about: string;
  form?: SField;
  /** The value in words on the row, when the form's own summary would not read well. */
  summary?: (v: unknown) => string;
  /** A starting value when nothing is saved. */
  fresh?: unknown;
  /** While this rule is on, it decides this setting. */
  decidedBy?: { policyId: string; title: string; read?: (policy: Rec) => string; lead?: string; rest?: string };
  /** Nothing reads this yet: why, in words. The row is set apart at the foot of its page. */
  unused?: string;
  /** A refusal that needs the whole value. */
  check?: (v: unknown) => string | null;
  /** Filled in just before saving, such as a code made from a description. */
  normalise?: (v: unknown) => unknown;
  /** The page it is edited on. */
  page: string;
  pageTitle: string;
};

// ---- shared words --------------------------------------------------------------------------------

/** The only three a notification may name (notification-service). */
const NOTIFY_OPTIONS: Opt[] = [
  { value: "OPERATOR", label: "Front desk" },
  { value: "FOM", label: "FOM" },
  { value: "GM", label: "GM" },
];
const VIP_OPTIONS: Opt[] = NOTIFY_OPTIONS.filter((r) => r.value !== "OPERATOR");

const STAGES = [
  { key: "S1", label: "Inquiry" },
  { key: "S2", label: "Negotiation" },
  { key: "S3", label: "Set up" },
  { key: "S4", label: "Reserve" },
  { key: "S5", label: "Arrival" },
  { key: "S6", label: "Check-in" },
  { key: "S7", label: "Stay" },
];

const BILLING_MODEL_OPTIONS: Opt[] = [
  { value: "GUEST_PAY", label: "The guest pays" },
  { value: "DIRECT_BILL", label: "Billed to the company" },
  { value: "TOUR_OPERATOR_VOUCHER", label: "Agency voucher" },
  { value: "GOVERNMENT", label: "Government" },
];

const SOURCE_OPTIONS: Opt[] = [
  { value: "DIRECT", label: "Direct" },
  { value: "WALK_IN", label: "Walk-in" },
  { value: "OTA", label: "Online booking sites" },
  { value: "AGENT", label: "Travel agents" },
  { value: "CORPORATE", label: "Companies" },
];

const dur = (base: "seconds" | "minutes" | "hours" | "days", key: string | undefined, label: string, min?: number): SField => ({
  kind: "duration",
  key,
  label,
  base,
  min,
  units: base === "days" ? ["days"] : base === "hours" ? ["days", "hours"] : ["days", "hours", "minutes"],
});
const seconds = (key: string | undefined, label: string, min?: number) => dur("seconds", key, label, min);
const minutes = (key: string | undefined, label: string, min?: number) => dur("minutes", key, label, min);
const hours = (key: string | undefined, label: string, min?: number) => dur("hours", key, label, min);
const days = (key: string | undefined, label: string, min?: number) => dur("days", key, label, min);

const LOOKED_AFTER = "Nothing reads this yet, so changing it changes nothing.";

const templateRows = (label: string): SField => ({
  kind: "rows",
  label,
  addLabel: "Add a template",
  word: ["template", "templates"],
  blank: { templateKey: "", isActive: true },
  columns: [
    { kind: "text", key: "templateKey", label: "Template", placeholder: "final-v1" },
    { kind: "toggle", key: "isActive", label: "In use", on: "In use", off: "Not in use" },
  ],
});

const slug = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/** A checklist line keeps its code once it has one; a new line takes one from its words. */
const fillChecklistCodes = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((row, i) => {
    const r = asRec(row);
    return { ...r, code: typeof r.code === "string" && r.code ? r.code : slug(String(r.description ?? "")) || `ITEM_${i + 1}` };
  });

const checklistForm = (label: string): SField => ({
  kind: "rows",
  label,
  addLabel: "Add a line",
  word: ["line", "lines"],
  reorder: true,
  emptyText: "Nothing on this checklist yet.",
  blank: { description: "", mandatory: true },
  columns: [
    { kind: "text", key: "description", label: "What is checked", placeholder: "Room and stay details confirmed", wide: true },
    { kind: "toggle", key: "mandatory", label: "Must it be ticked?", on: "Must be ticked", off: "Optional" },
  ],
});

// ---- the page each setting lives on --------------------------------------------------------------

type Draft = Omit<SettingDef, "page" | "pageTitle">;

const page = (href: string, pageTitle: string, defs: Draft[]): SettingDef[] => defs.map((d) => ({ ...d, page: href, pageTitle }));

const TIME_LIMITS = page("/admin/timers-workers", "Time limits", [
  {
    key: "expiry.s1.defaultTtlSeconds",
    title: "An inquiry lapses after",
    about: "How long an inquiry can sit with nothing happening before it lapses by itself. Parking stops the clock.",
    form: { kind: "group", label: "", fields: [seconds("DEFAULT", "Lapses after", 60)] },
    decidedBy: { policyId: "registry.s1Expiry.minutes", title: "An inquiry lapses after", read: (p) => durationInWords(p.minutes, "minutes") },
    summary: (v) => durationInWords(asRec(v).DEFAULT ?? 0, "seconds"),
  },
  {
    key: "expiry.s2.speculativeHoldTtlSeconds",
    title: "A provisional block lasts",
    about: "How long a provisional block marks the rooms at Negotiation before they are let go.",
    form: seconds(undefined, "Lasts", 60),
    decidedBy: { policyId: "registry.s2HoldExpiry.minutes", title: "A provisional block lasts", read: (p) => durationInWords(p.minutes, "minutes") },
  },
  {
    key: "expiry.s3.committedHoldTtlSeconds",
    title: "Rooms stay blocked for",
    about: "How long rooms stay blocked at Set up before they are let go, unless the booking has a block time of its own.",
    form: seconds(undefined, "Blocked for", 60),
    decidedBy: { policyId: "registry.holdExpiry.minutes", title: "Rooms stay blocked for", read: (p) => durationInWords(p.minutes, "minutes") },
  },
  {
    key: "expiry.parking.followUpDays",
    title: "A parked booking lapses after",
    about: "How long a booking can stay parked before it lapses.",
    form: days(undefined, "Lapses after", 1),
  },
  {
    key: "preArrival.windowDays",
    title: "Arrival opens",
    about: "How many days before check-in a reserved booking moves to the Arrival step.",
    form: days(undefined, "Before check-in", 0),
  },
  {
    key: "stayExtension.holdTtlSeconds",
    title: "Extra nights are held for",
    about: "How long a requested stay extension keeps its extra nights for the guest while the bill goes out and the money comes in. Unpaid after that, the request lapses and the nights are let go.",
    form: seconds(undefined, "Held for", 60),
  },
  {
    key: "availability.staleness.ttlSeconds",
    title: "A room search goes stale after",
    about: "After this long the answer to a search is too old to save rooms from, and the desk has to ask the house again.",
    form: seconds(undefined, "After", 60),
  },
  {
    key: "stageDwell.thresholds",
    title: "Warnings when a booking waits",
    about: "How long a booking can wait at a step before each warning goes up. Each kind of waiting has its own times. A warning is listed under Notifications, Alerts sent; nobody is sent a message.",
    form: {
      kind: "grid",
      label: "Warnings",
      rowLabel: "Step",
      subLabel: "When it is",
      rows: STAGES,
      subRows: [
        { key: "ACTIVE", label: "Being worked" },
        { key: "IDLE", label: "Sitting idle" },
        { key: "PARKED", label: "Parked" },
      ],
      columns: [
        { key: "warning", label: "First warning" },
        { key: "critical", label: "Second warning" },
        { key: "escalation", label: "Escalate" },
      ],
      cell: { kind: "duration", label: "After", base: "seconds", units: ["hours", "minutes"], compact: true, min: 60 },
    },
    summary: () => "A time for each step",
  },
  {
    key: "deficientResolution.deadlineHours",
    title: "Time to fix a fault",
    about: "How long housekeeping or maintenance has to put a reported fault right before it is escalated.",
    form: hours(undefined, "Time to fix", 1),
    decidedBy: { policyId: "registry.deficientResolution.deadlineHours", title: "Time to fix a fault", read: (p) => durationInWords(p.hours, "hours") },
  },
  {
    key: "lostFound.retention.warningOffsetDays",
    title: "Warn before lost property goes",
    about: "How many days before lost property reaches the end of its keeping time the desk is warned.",
    form: days(undefined, "Warn before", 0),
    decidedBy: { policyId: "registry.lostFound.retentionWarning.days", title: "Warn before lost property goes", read: (p) => durationInWords(p.days, "days") },
  },
  {
    key: "followUp.deadlineDays",
    title: "Follow-up after the stay is due within",
    about: "How many days a follow-up after the stay has before it is overdue.",
    form: days(undefined, "Within", 1),
  },
  {
    key: "feedback.solicitation.delaySeconds",
    title: "Ask for feedback after",
    about: "How long after the guest leaves the feedback email goes out.",
    form: seconds(undefined, "After", 1),
  },
  {
    key: "commission.rateMissing.resolutionSeconds",
    title: "Time to sort out a missing commission rate",
    about: "How long there is to give an agency a commission rate before it is flagged.",
    form: seconds(undefined, "Within", 60),
  },
  {
    key: "noShow.awaitingConfirmationWindowMinutes",
    title: "Waiting to confirm a no-show",
    about: "How long a possible no-show waits to be confirmed, when the desk does not say.",
    form: minutes(undefined, "Waits", 1),
  },
  {
    key: "availability.conferenceSpace.turnaroundBufferMinutes",
    title: "Time to turn a hall around",
    about: "The gap kept between two uses of a hall.",
    form: minutes(undefined, "Gap", 0),
  },
]);

const FINANCIAL = page("/admin/financial", "Payments and bills", [
  {
    key: "billing.salesTaxRate",
    title: "GST",
    about: "The GST charged on every bill. It is worked out on the net value plus the service charge.",
    form: { kind: "percent", label: "GST", stored: "fraction", step: 0.5 },
  },
  {
    key: "billing.serviceChargeRate",
    title: "Service charge",
    about: "The service charge added to the net value, before GST.",
    form: { kind: "percent", label: "Service charge", stored: "fraction", step: 0.5 },
  },
  {
    key: "advancePayment.thresholds",
    title: "The advance asked of a guest",
    about: "How much advance a booking asks for by default. The desk can set a different amount on any booking at Set up. A figure for one source applies only when it is above 0.",
    form: {
      kind: "map",
      label: "The advance",
      keyLabel: "Bookings from",
      rows: [{ key: "DEFAULT", label: "Everyone" }],
      addLabel: "Add a source",
      addOptions: SOURCE_OPTIONS,
      blank: { amount: 0 },
      value: { kind: "group", label: "", fields: [{ kind: "money", key: "amount", label: "Amount" }] },
    },
  },
  {
    key: "advancePayment.followUpWindowSeconds",
    title: "First reminder about an advance",
    about: "How long after the bill goes out the desk gets the first reminder, if the advance has not come in.",
    form: seconds(undefined, "After", 60),
    decidedBy: { policyId: "registry.advancePaymentFollowUp.windowSeconds", title: "First reminder about an advance", read: (p) => durationInWords(p.seconds, "seconds") },
  },
  {
    key: "advancePayment.escalationWindowSeconds",
    title: "Second reminder about an advance",
    about: "How long after the bill goes out it is escalated. It should be longer than the first reminder.",
    form: seconds(undefined, "After", 60),
  },
  {
    key: "payment.followUp.ttlDays",
    title: "Remind about money owed after",
    about: "How many days after the stay the desk is reminded about money still owed.",
    form: days(undefined, "After", 1),
  },
  {
    key: "dispute.sla",
    title: "Answering a dispute",
    about: "How long the desk has to first answer a guest's dispute, and when it is reminded to settle it. The reminder must come after the first answer.",
    form: {
      kind: "group",
      label: "",
      fields: [minutes("firstResponseDueMinutes", "First answer within", 1), minutes("resolutionReminderMinutes", "Remind to settle it after", 1)],
    },
    check: (v) => {
      const o = asRec(v);
      return Number(o.resolutionReminderMinutes) <= Number(o.firstResponseDueMinutes) ? "The reminder to settle it must come after the first answer." : null;
    },
  },
  {
    key: "fomOverride.frequency",
    title: "Too many FOM overrides",
    about: "The GM is told when the FOM overrides a dispute hold more than this many times in the period.",
    form: {
      kind: "group",
      label: "",
      fields: [{ kind: "number", key: "maxFrequency", label: "More than", unit: "times", min: 1, whole: true }, days("rollingWindowDays", "In any", 1)],
    },
    decidedBy: { policyId: "registry.fomOverride.frequency", title: "Too many FOM overrides", read: (p) => `${p.maxFrequency} times in ${durationInWords(p.rollingWindowDays, "days").toLowerCase()}` },
  },
  { key: "payment.followUp.intervals", title: "Reminder days after check-out", about: "Days after check-out for money-owed reminders.", unused: LOOKED_AFTER, form: { kind: "numberList", label: "Reminder days", unit: "days", placeholder: "7" } },
  { key: "invoice.templates", title: "Bill templates", about: "The bill layouts on file.", unused: "The bills' layouts are built in, so nothing reads this yet.", form: templateRows("Bill templates") },
  { key: "invoice.templates.final", title: "Tax invoice templates", about: "The tax invoice layouts on file.", unused: "The tax invoice's layout is built in, so nothing reads this yet.", form: templateRows("Tax invoice templates") },
  { key: "invoice.templates.proforma", title: "Proforma templates", about: "The proforma layouts on file.", unused: "The proforma's layout is built in, so nothing reads this yet.", form: templateRows("Proforma templates") },
  {
    key: "proformaInvoice.templates",
    title: "Which proforma layout",
    about: "The layout a proforma invoice is printed with.",
    unused: "The proforma's layout is built in, so nothing reads this yet.",
    form: { kind: "map", label: "Template", keyLabel: "For", rows: [{ key: "DEFAULT", label: "Every booking" }], value: { kind: "text", label: "Template", placeholder: "proforma-v1" } },
  },
]);

const OPERATIONAL = page("/admin/operational", "Daily schedule", [
  {
    key: "nightAudit.scheduleTime",
    title: "Night audit runs at",
    about: "The time of day the hotel's night audit runs, on the hotel's clock. It audits the night that has just ended. A new time takes effect at once.",
    form: { kind: "time", label: "Every day at" },
    summary: (v) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? timeInWords(v) : "An older schedule · pick a time to replace it"),
  },
  {
    key: "nightAudit.schedule",
    title: "Stay-night reminder at",
    about: "The hour each stay night's reminder goes up, on the hotel's clock.",
    form: { kind: "group", label: "", fields: [{ kind: "hotelHour", key: "stayNightReminderHourUtc", label: "Every day at" }] },
  },
  {
    key: "checkIn.standardTime",
    title: "Check-in time",
    about: "A booking is expected at this time on its arrival day, unless the guest gave a time of their own. The no-show time counts from it.",
    form: { kind: "time", label: "Check-in time" },
  },
  {
    key: "checkout.cutoffTime",
    title: "Check-out time",
    about: "After this time on the day they leave, a guest still in the room is flagged as a late check-out. A guest arriving the next morning must come before it.",
    form: { kind: "time", label: "Check-out time" },
  },
  {
    key: "noShow.cutoffWindowMinutes",
    title: "No-show after",
    about: "How long after the guest was expected they count as a no-show.",
    form: minutes(undefined, "After", 0),
    decidedBy: { policyId: "registry.noShow.graceMinutes", title: "A guest counts as a no-show after", read: (p) => durationInWords(p.graceMinutes, "minutes") },
  },
  {
    key: "housekeeping.sla.windowMinutes",
    title: "Time to clean a room",
    about: "How long housekeeping has to clean a room after the guest leaves. The Housekeeping page shows a room as late past this.",
    form: minutes(undefined, "Time to clean", 1),
  },
  {
    key: "inspection.postCheckout.windowHours",
    title: "Inspecting a room after departure",
    about: "When an inspection is put off at check-out, how long there is to do it before the chance closes.",
    form: hours(undefined, "Within", 1),
  },
  {
    key: "room.readiness.slaWindow",
    title: "Time to get a room ready",
    about: "How long a room can take to be got ready.",
    unused: `${LOOKED_AFTER} The time that is used is "Time to ready a room for its guest", under Other settings.`,
    form: seconds(undefined, "Within", 60),
  },
  {
    key: "nightAudit.expectedChargesRules",
    title: "Charges the night audit expects",
    about: "What the night audit expects to find on the bill by kind of charge.",
    unused: LOOKED_AFTER,
    form: {
      kind: "map",
      label: "Expected",
      keyLabel: "Kind of charge",
      rows: [],
      addLabel: "Add a kind of charge",
      addOptions: [
        { value: "ROOM_CHARGE", label: "Room" },
        { value: "F_AND_B", label: "Food and drink" },
        { value: "SERVICE", label: "Services" },
        { value: "OTHER", label: "Other" },
      ],
      blank: 0,
      value: { kind: "money", label: "Expected" },
    },
  },
  {
    key: "roomAssignment.priorityRules",
    title: "Which rooms are given first",
    about: "The order rooms would be preferred in.",
    unused: `${LOOKED_AFTER} The system chooses rooms by its own rule.`,
    form: { kind: "tags", label: "In order", placeholder: "Type a rule and press Enter" },
  },
]);

const COMMERCIAL = page("/admin/commercial", "Limits", [
  {
    key: "discount.fom.maxPercentage",
    title: "Discount the front desk may give",
    about: "The most the front desk may take off a quotation. Above it, the FOM has to generate the quotation.",
    form: { kind: "percent", label: "Up to", stored: "whole" },
    decidedBy: { policyId: "registry.discount.actorCeiling", title: "Discount each person may give", read: (p) => `front desk ${p.l1MaxPercent}%` },
  },
  {
    key: "discount.gm.maxPercentage",
    title: "Discount the FOM may give",
    about: "The most the FOM may take off a quotation. Above it, the GM has to generate the quotation.",
    form: { kind: "percent", label: "Up to", stored: "whole" },
    decidedBy: {
      policyId: "registry.discount.actorCeiling",
      title: "Discount each person may give",
      read: (p) => `FOM ${p.l2MaxPercent}%`,
      rest: "The limit on any discount request still reads this figure.",
    },
  },
  {
    key: "creditCeiling.proximityThresholds",
    title: "Warnings as credit runs out",
    about: "How much of a guest's credit can be used before the desk gets each warning. These only warn; the hard stops are House rules.",
    form: {
      kind: "group",
      label: "",
      fields: [
        { kind: "percent", key: "tier1Percent", label: "First warning at", stored: "whole" },
        { kind: "percent", key: "tier2Percent", label: "Second warning at", stored: "whole" },
      ],
    },
    decidedBy: {
      policyId: "registry.creditCeiling.advisoryThresholds",
      title: "Credit: early warnings",
      lead: "At Stay, while the house rule",
      read: (p) => `${p.tier1Percent}% and ${p.tier2Percent}%`,
      rest: "Arrival still reads the figures here.",
    },
  },
  {
    key: "foc.configuration",
    title: "Free rooms",
    about: "Whether a room may be given free of charge, and how many rooms a booking must take for each free one. A free room always needs the GM.",
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        { kind: "toggle", key: "enabled", label: "Free rooms are", on: "Allowed", off: "Not allowed" },
        {
          kind: "group",
          label: "",
          when: (v) => v.enabled === true,
          fields: [
            {
              kind: "group",
              key: "entitlement",
              label: "",
              fields: [{ kind: "number", key: "perRooms", label: "One free for every", unit: "rooms", min: 1, whole: true, optional: true, blank: "10" }],
            },
          ],
        },
      ],
    },
    summary: (v) => {
      const o = asRec(v);
      return o.enabled === true ? `Allowed · one for every ${asRec(o.entitlement).perRooms ?? 10} rooms` : "Not allowed";
    },
  },
  {
    key: "overbooking.maxAllowedRooms",
    title: "Extra bookings on one room",
    about: "How many extra bookings may sit on the same room on the same night. Leave it at 0 to never overbook.",
    form: { kind: "number", label: "Up to", unit: "extra bookings", min: 0, whole: true },
  },
  {
    key: "confirmation.authorityThresholds",
    title: "High-value bookings need the FOM",
    about: "A booking above this room rate a night needs the FOM or the GM to reserve it. At 0, anyone may.",
    form: { kind: "group", label: "", fields: [{ kind: "money", key: "highValueAmount", label: "Above, a night" }] },
  },
  {
    key: "speculativeHold.placementThresholds",
    title: "Who may place a provisional block",
    about: "Who may mark rooms at Negotiation, by how many rooms are marked. Put the smallest first; the first line that fits decides. Leave the rooms empty on the last line for any number.",
    form: {
      kind: "group",
      label: "",
      fields: [
        {
          kind: "rows",
          key: "thresholds",
          label: "Limits",
          addLabel: "Add a line",
          word: ["line", "lines"],
          reorder: true,
          blank: { maxRooms: null, authorityRequired: "FRONT_DESK", maxConcurrentHolds: null },
          columns: [
            { kind: "number", key: "maxRooms", label: "Up to this many rooms", min: 1, whole: true, optional: true, blank: "Any number" },
            {
              kind: "select",
              key: "authorityRequired",
              label: "Who may do it",
              options: [
                { value: "FRONT_DESK", label: "Front desk" },
                { value: "FOM", label: "FOM" },
                { value: "GM", label: "GM" },
              ],
            },
          ],
        },
      ],
    },
    summary: (v) => {
      const WORD: Record<string, string> = { FRONT_DESK: "Front desk", FOM: "FOM", GM: "GM" };
      const rows = (Array.isArray(asRec(v).thresholds) ? (asRec(v).thresholds as unknown[]) : []).map(asRec);
      return rows.length ? rows.map((r) => `${WORD[String(r.authorityRequired)] ?? r.authorityRequired} ${r.maxRooms == null ? "any number" : `up to ${r.maxRooms}`}`).join(" · ") : "None";
    },
    check: (v) => {
      const rows = (Array.isArray(asRec(v).thresholds) ? (asRec(v).thresholds as unknown[]) : []).map(asRec);
      let last = 0;
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i].maxRooms;
        if (m == null) {
          if (i !== rows.length - 1) return "The line for any number of rooms must come last, or the lines after it are never reached.";
        } else {
          if (Number(m) <= last) return "Put the smallest number of rooms first, or a later line is never reached.";
          last = Number(m);
        }
      }
      return null;
    },
  },
  {
    key: "writeOff.authority.thresholds",
    title: "The most one write-off can be",
    about: "The most that can be written off at once, for anyone. A larger amount cannot be written off. At 0 there is no limit.",
    form: { kind: "group", label: "", fields: [{ kind: "money", key: "L3", label: "At most" }] },
  },
  {
    key: "creditCeiling.clientTier.thresholds",
    title: "Credit by kind of guest",
    about: "A credit figure for each kind of guest.",
    unused: `${LOOKED_AFTER} The FOM enters the credit on each booking.`,
    form: {
      kind: "map",
      label: "Credit up to",
      keyLabel: "Guest",
      rows: [
        { key: "preferred", label: "Preferred" },
        { key: "standard", label: "Standard" },
        { key: "caution", label: "Caution" },
        { key: "restricted", label: "Restricted" },
      ],
      value: { kind: "money", label: "Credit up to" },
    },
  },
]);

const CANCELLATION = page("/admin/cancellation-policies", "Cancellation policies", [
  {
    key: "cancellation.policyTiers",
    title: "What the desk charges on a cancellation",
    about: "The charge when a booking is cancelled, or a guest walks out after check-in, unless the booking was given a charge of its own. It is never more than the money received. A no-show pays this too when no no-show charge is set.",
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        {
          kind: "group",
          label: "",
          fields: [
            { kind: "money", key: "sameDayPenaltyAmount", label: "The usual charge" },
            { kind: "money", key: "preArrivalPenaltyAmount", label: "Instead, before arrival", optional: true, blank: "The usual charge", help: "Leave it empty to charge the usual amount." },
            { kind: "money", key: "postCheckInEarlyDeparturePenaltyAmount", label: "A walk-out after check-in", optional: true, blank: "The usual charge", help: "Leave it empty, or at 0, to charge the usual amount." },
          ],
        },
        {
          kind: "rows",
          key: "tiers",
          label: "Or by time left before check-in",
          help: "Any line here takes the place of the charges above for a cancellation before arrival. The line with the most time that still fits decides.",
          addLabel: "Add a line",
          word: ["line", "lines"],
          emptyText: "No lines: the charges above apply.",
          blank: { minHoursBeforeCheckIn: 24, penaltyAmount: 0 },
          columns: [
            { kind: "duration", key: "minHoursBeforeCheckIn", label: "With at least this long left", base: "hours", units: ["days", "hours"] },
            { kind: "money", key: "penaltyAmount", label: "They pay" },
          ],
        },
      ],
    },
    summary: (v) => {
      const o = asRec(v);
      if (o.sameDayPenaltyAmount == null) return "Not set";
      const lines = Array.isArray(o.tiers) && o.tiers.length ? ` · ${o.tiers.length} lines by time left` : "";
      return `Nu ${o.sameDayPenaltyAmount}${o.postCheckInEarlyDeparturePenaltyAmount ? ` · walk-out Nu ${o.postCheckInEarlyDeparturePenaltyAmount}` : ""}${lines}`;
    },
  },
]);

/** One setting per email: must the desk note the guest's reply to it? (2026-11-03) */
const guestReply = (key: string, title: string, about: string): Draft => ({
  key,
  title,
  about: `${about} While it is off, the booking's steps do not ask for a reply or offer to note one.`,
  form: { kind: "group", label: "", fields: [{ kind: "toggle", key: "required", label: "The guest's reply", on: "Must be noted", off: "Not needed" }] },
  summary: (v) => ((v as { required?: boolean } | null)?.required === false ? "Not needed" : "Must be noted"),
  fresh: { required: true },
});

const COMMUNICATION = page("/admin/communication-config", "Channels and replies", [
  guestReply("guestReply.quotation", "Reply to a quotation", "Nothing is held up by this reply. Off stops the desk waiting for it, and its clock."),
  guestReply(
    "guestReply.proforma",
    "Reply to a proforma invoice",
    "Once a proforma is sent, the advance cannot be logged and the booking cannot be reserved until the reply is noted. Off lets both go ahead.",
  ),
  guestReply(
    "guestReply.confirmationVoucher",
    "Reply to a confirmation voucher",
    "Once a voucher is sent, the booking cannot move to Arrival until the reply is noted. Off lets it move.",
  ),
  guestReply("guestReply.preArrivalMessage", "Reply to a pre-arrival message", "Nothing is held up by this reply. Off stops the desk waiting for it, and its clock."),
  guestReply(
    "guestReply.interimBill",
    "Reply to a mid-stay bill",
    "Once a mid-stay bill is sent, its payment cannot be logged until the reply is noted. Off lets the payment be logged.",
  ),
  guestReply(
    "guestReply.taxInvoice",
    "Reply to a tax invoice",
    "Once a tax invoice is sent, a payment against it after the stay cannot be logged until the reply is noted. Off lets the payment be logged.",
  ),
  {
    key: "acknowledgement.windowPerType",
    title: "How long to wait for an answer",
    about: "How long the desk waits for the guest's answer to each paper, or a department's answer to a handoff, before it is chased. A tax invoice and a mid-stay bill use the proforma's time unless they have their own.",
    form: {
      kind: "map",
      label: "Wait",
      keyLabel: "After sending",
      rows: [
        { key: "quotation", label: "A quotation" },
        { key: "pi", label: "A proforma invoice" },
        { key: "voucher", label: "A confirmation voucher" },
        { key: "preArrival", label: "A pre-arrival message" },
        { key: "interimInvoice", label: "A mid-stay bill" },
        { key: "finalInvoice", label: "A tax invoice" },
        { key: "h2", label: "A handoff to housekeeping" },
        { key: "h3", label: "A handoff to the kitchen" },
        { key: "h4", label: "A handoff before departure" },
        { key: "vipArrival", label: "A VIP arrival" },
        { key: "amendment", label: "A change to a booking" },
        { key: "cancellation", label: "A cancellation" },
        { key: "invoice", label: "An invoice" },
      ],
      value: seconds(undefined, "Wait", 60),
    },
    summary: () => "A time for each paper",
  },
  {
    key: "communication.channels",
    title: "Channels",
    about: "The ways of reaching a guest. A saved password or key is never shown, and stays as it is.",
    unused: `${LOOKED_AFTER} Email is set up on the server, and the desk records a WhatsApp send by hand.`,
    form: {
      kind: "map",
      label: "Channel",
      keyLabel: "Channel",
      rows: [
        { key: "EMAIL", label: "Email" },
        { key: "WHATSAPP", label: "WhatsApp" },
        { key: "PHONE", label: "Phone" },
        { key: "FRONT_DESK", label: "Front desk" },
      ],
      addLabel: "Add a channel",
      addPlaceholder: "SMS",
      blank: { enabled: false },
      value: {
        kind: "group",
        label: "",
        fields: [
          { kind: "toggle", key: "enabled", label: "In use", on: "In use", off: "Not in use" },
          { kind: "text", key: "displayName", label: "Name", optional: true, placeholder: "Email" },
        ],
      },
    },
    summary: (v) => {
      const on = Object.entries(asRec(v))
        .filter(([, c]) => asRec(c).enabled === true)
        .map(([k, c]) => String(asRec(c).displayName ?? k));
      return on.length ? on.join(", ") : "None";
    },
  },
]);

const OTA = page("/admin/ota-config", "Online booking sites", [
  {
    key: "noShow.penaltyStructure",
    title: "What a no-show is charged",
    about: "How much a no-show pays, by where the booking came from, on rooms with tax and without meals, and never more than the money received. A source with no line uses Everyone else.",
    form: {
      kind: "map",
      label: "Charged",
      keyLabel: "Bookings from",
      rows: [
        { key: "DEFAULT", label: "Everyone else" },
        { key: "DIRECT", label: "Direct" },
        { key: "WALK_IN", label: "Walk-in" },
        { key: "OTA", label: "Online booking sites" },
        { key: "AGENT", label: "Travel agents" },
        { key: "CORPORATE", label: "Companies" },
      ],
      value: {
        kind: "group",
        label: "",
        fields: [
          { kind: "percent", key: "penaltyPercent", label: "They pay", stored: "whole" },
          {
            kind: "select",
            key: "basis",
            label: "Of",
            optional: true,
            placeholder: "The first night",
            options: [
              { value: "FIRST_NIGHT", label: "The first night" },
              { value: "WHOLE_STAY", label: "The whole stay" },
            ],
          },
        ],
      },
    },
    summary: (v) => {
      const d = asRec(asRec(v).DEFAULT);
      if (d.penaltyPercent == null) return "Not set";
      return `${d.penaltyPercent}% of ${d.basis === "WHOLE_STAY" ? "the whole stay" : "the first night"}, by source`;
    },
  },
  {
    key: "ota.inbox.pollingIntervalSeconds",
    title: "Read the inbox every",
    about: "How often the system would look in the inbox for new bookings from online booking sites.",
    unused: "The inbox reader is not running yet, so nothing reads this.",
    form: seconds(undefined, "Every", 60),
  },
  {
    key: "ota.sourceFlagConfig",
    title: "Marking a booking as from a site",
    about: "Whether bookings from online booking sites are marked as such.",
    unused: `${LOOKED_AFTER} A booking is marked by how it came in.`,
    form: { kind: "map", label: "Marked", keyLabel: "Source", rows: [{ key: "OTA", label: "Online booking sites" }], value: { kind: "toggle", label: "Marked", on: "On", off: "Off" } },
  },
  {
    key: "ota.conflictTriggerRules",
    title: "What counts as a clash",
    about: "What would make a booking from a site need the desk to sort it out by hand.",
    unused: LOOKED_AFTER,
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        { kind: "toggle", key: "detectDoubleBooking", label: "The room is already booked" },
        { kind: "toggle", key: "detectDateOverlap", label: "The dates overlap another booking" },
        { kind: "toggle", key: "detectRateMismatch", label: "The rate does not match ours" },
      ],
    },
    summary: (v) => `${Object.values(asRec(v)).filter((x) => x === true).length} of 3 on`,
  },
  {
    key: "noShow.cutoffMinutes",
    title: "No-show after, for these bookings",
    about: "How long after the guest was expected a booking from a site would count as a no-show.",
    unused: `${LOOKED_AFTER} Every booking uses "No-show after" under Daily schedule.`,
    form: minutes(undefined, "After", 0),
  },
]);

const AI = page("/admin/ai-agent-config", "AI agent", [
  {
    key: "processingLock.ttl.perChannel",
    title: "How long a booking stays locked",
    about: "While a person or the AI is working a booking from a channel, it is locked to them. The lock lets go after this long.",
    form: {
      kind: "map",
      label: "Lets go after",
      keyLabel: "Channel",
      rows: [
        { key: "FRONT_DESK", label: "Front desk" },
        { key: "PHONE", label: "Phone" },
        { key: "EMAIL_AI", label: "Email, by the AI" },
        { key: "WHATSAPP_AI", label: "WhatsApp, by the AI" },
      ],
      value: seconds(undefined, "Lets go after", 60),
    },
    summary: () => "A time for each channel",
  },
  {
    key: "ai.agentConfig",
    title: "What the AI may do alone",
    about: "How much the AI may do without a person, by kind of request.",
    unused: "The AI agent is not running yet, so nothing reads this.",
    fresh: {},
    form: {
      kind: "group",
      label: "",
      fields: [
        {
          kind: "map",
          key: "trustLevels",
          label: "It may",
          keyLabel: "Kind of request",
          rows: [],
          addLabel: "Add a kind of request",
          addPlaceholder: "BOOKING_INQUIRY",
          blank: "ALWAYS_REQUIRE_APPROVAL",
          value: {
            kind: "select",
            label: "It may",
            options: [
              { value: "ALWAYS_REQUIRE_APPROVAL", label: "Always ask a person" },
              { value: "AUTO_APPROVE_HIGH_CONFIDENCE", label: "Act alone when it is sure" },
              { value: "FULL_AUTO", label: "Always act alone" },
            ],
          },
        },
      ],
    },
    summary: (v) => {
      const n = Object.keys(asRec(asRec(v).trustLevels)).length;
      return n ? `${n} kinds of request` : "None";
    },
  },
  {
    key: "ai.confidence.thresholds.perIntent",
    title: "How sure the AI must be",
    about: "How sure the AI must be of a booking email before it acts by itself.",
    unused: "The inbox reader is not running yet, so nothing reads this.",
    form: { kind: "group", label: "", fields: [{ kind: "percent", key: "DEFAULT", label: "At least", stored: "fraction" }] },
  },
]);

const POST_STAY = page("/admin/post-stay", "Feedback and records", [
  {
    key: "identity.documentTypes",
    title: "ID documents we accept",
    about: "The kinds of ID the desk can pick when it records a guest. With none listed, any document is accepted. Keep a short code once it is in use: documents on file refer to it, and the ID reader uses PASSPORT, CID, VOTER_CARD, BIRTH_CERTIFICATE, WORK_PERMIT and AADHAAR_CARD.",
    form: {
      kind: "rows",
      label: "ID documents",
      addLabel: "Add a document",
      word: ["document", "documents"],
      reorder: true,
      blank: { documentTypeCode: "", documentTypeName: "", isActive: true },
      columns: [
        { kind: "text", key: "documentTypeName", label: "Name", placeholder: "Passport", wide: true },
        { kind: "text", key: "documentTypeCode", label: "Short code", placeholder: "PASSPORT" },
        { kind: "toggle", key: "isActive", label: "In use", on: "In use", off: "Not in use" },
      ],
    },
    summary: (v) => {
      const a = (Array.isArray(v) ? v : []).map(asRec).filter((r) => r.isActive !== false);
      return a.length ? `${a.length} in use` : "Any document";
    },
  },
  {
    key: "identity.retentionPeriodDays",
    title: "How long ID copies are kept",
    about: "How many days a stored copy of an ID is kept. A document with no line of its own uses Any other document.",
    form: {
      kind: "map",
      label: "Kept for",
      keyLabel: "Document",
      rows: [{ key: "DEFAULT", label: "Any other document" }],
      addLabel: "Add a document",
      addOptions: [
        { value: "PASSPORT", label: "Passport" },
        { value: "CID", label: "CID (National ID)" },
        { value: "AADHAAR_CARD", label: "Aadhaar card" },
        { value: "VOTER_CARD", label: "Voter card" },
        { value: "BIRTH_CERTIFICATE", label: "Birth certificate" },
        { value: "WORK_PERMIT", label: "Work permit" },
      ],
      blank: 2555,
      value: days(undefined, "Kept for", 1),
    },
    summary: (v) => `${durationInWords(asRec(v).DEFAULT ?? 0, "days")}, by document`,
  },
  {
    key: "feedback.platformLinks",
    title: "Where guests leave a review",
    about: "The review pages for the feedback email.",
    unused: `${LOOKED_AFTER} The feedback email does not name a review page.`,
    fresh: {},
    form: {
      kind: "map",
      label: "Link",
      keyLabel: "Site",
      rows: [
        { key: "google", label: "Google" },
        { key: "tripadvisor", label: "Tripadvisor" },
        { key: "booking", label: "Booking.com" },
      ],
      value: { kind: "text", label: "Link", placeholder: "https://", wide: true, optional: true },
    },
  },
  {
    key: "government.submissionConfig",
    title: "Sending guest records to the government",
    about: "Whether guest records would go to the government's portal.",
    unused: "Nothing sends guest records yet, so nothing reads this.",
    fresh: { enabled: false },
    form: { kind: "group", label: "", fields: [{ kind: "toggle", key: "enabled", label: "Sending is" }] },
  },
]);

const MESSAGES = page("/admin/templates", "Templates", [
  { key: "handoff.H1.checklist", title: "Handoff to the front desk", about: "What is checked when a reserved booking is handed to the front desk at Arrival.", form: checklistForm("Checklist"), normalise: fillChecklistCodes },
  { key: "handoff.H2.checklist", title: "Handoff to housekeeping", about: "What housekeeping checks when a guest checks in.", form: checklistForm("Checklist"), normalise: fillChecklistCodes },
  { key: "handoff.H3.checklist", title: "Handoff to the kitchen and bar", about: "What the kitchen and bar check when a guest checks in.", form: checklistForm("Checklist"), normalise: fillChecklistCodes },
  { key: "handoff.H4.checklist", title: "Handoff before departure", about: "What is checked as the guest gets ready to leave.", form: checklistForm("Checklist"), normalise: fillChecklistCodes, fresh: [] },
]);

export const CLAIM_STATE_OPTIONS: Opt[] = [
  { value: "FREE", label: "Free" },
  { value: "SPECULATIVELY_HELD", label: "Provisional block" },
  { value: "COMMITTED_HELD", label: "Blocked" },
  { value: "CONFIRMED", label: "Reserved" },
  { value: "OCCUPIED", label: "Guest in it" },
  { value: "DEPARTED_DIRTY", label: "Needs cleaning" },
  { value: "DEPARTED_CLEAN", label: "Cleaned" },
];

const OTHER = page("/admin/configuration", "Other settings", [
  {
    key: "earlyDeparture.penalty",
    title: "The early departure fee",
    about: "What a guest leaving before their check-out date is charged for the nights they give up. The GM may waive it. The nights already slept are never priced again.",
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        {
          kind: "choice",
          key: "basis",
          label: "The fee is",
          options: [
            { value: "NONE", label: "No fee" },
            { value: "FLAT_AMOUNT", label: "A set amount" },
            { value: "UNSTAYED_NIGHTS", label: "Some of the nights given up" },
            { value: "PERCENT_OF_UNSTAYED", label: "A share of all the nights given up" },
          ],
        },
        { kind: "group", label: "", when: (v) => v.basis === "FLAT_AMOUNT", fields: [{ kind: "money", key: "amount", label: "Amount, before tax" }] },
        {
          kind: "group",
          label: "",
          when: (v) => v.basis === "UNSTAYED_NIGHTS",
          fields: [
            { kind: "number", key: "nights", label: "Up to", unit: "nights", min: 1, whole: true },
            { kind: "percent", key: "percent", label: "Of each night's room price", stored: "whole" },
          ],
        },
        { kind: "group", label: "", when: (v) => v.basis === "PERCENT_OF_UNSTAYED", fields: [{ kind: "percent", key: "percent", label: "Of each night's room price", stored: "whole" }] },
      ],
    },
    summary: (v) => {
      const o = asRec(v);
      if (o.basis === "NONE") return "No fee";
      if (o.basis === "FLAT_AMOUNT") return `Nu ${o.amount}`;
      if (o.basis === "UNSTAYED_NIGHTS") return `Up to ${o.nights} night${o.nights === 1 ? "" : "s"} at ${o.percent}%`;
      if (o.basis === "PERCENT_OF_UNSTAYED") return `${o.percent}% of the nights given up`;
      return "Not set";
    },
  },
  {
    key: "interimPayment.schedule",
    title: "Asking for money on a long stay",
    about: "The night audit prompts the desk to ask for part of the bill on a long stay. The desk can always ask sooner.",
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        { kind: "toggle", key: "enabled", label: "The prompt is" },
        {
          kind: "group",
          label: "",
          fields: [
            { kind: "number", key: "everyNights", label: "Every", unit: "nights", min: 1, whole: true },
            { kind: "money", key: "minimumOutstanding", label: "When at least this is owed" },
          ],
        },
      ],
    },
  },
  {
    key: "interimPayment.reminder",
    title: "Reminders about a mid-stay payment",
    about: "When a mid-stay bill falls due, and how often the desk is reminded while it is unpaid.",
    form: {
      kind: "group",
      label: "",
      lines: true,
      fields: [
        { kind: "toggle", key: "enabled", label: "Reminders are" },
        {
          kind: "group",
          label: "",
          fields: [
            hours("dueAfterHours", "Falls due after", 1),
            hours("extensionLeadHours", "For an extension, before the held nights go", 0),
            hours("repeatEveryHours", "Remind again every", 1),
            { kind: "number", key: "maxReminders", label: "At most", unit: "reminders", min: 1, whole: true },
          ],
        },
      ],
    },
  },
  {
    key: "guestRequest.kinds",
    title: "Kinds of guest request",
    about: "The kinds the desk picks from when it takes a guest's request.",
    form: { kind: "tags", label: "Kinds of request", placeholder: "Airport pickup" },
  },
  {
    key: "deficientCondition.categories",
    title: "Kinds of fault",
    about: "The kinds of fault a person can pick when they report a room or a space. There are four; you can rename them or stop offering one.",
    form: {
      kind: "rows",
      label: "Kinds of fault",
      fixedKey: "code",
      fixedNames: { HOUSEKEEPING: "Housekeeping", MAINTENANCE: "Maintenance", SOFT_FURNISHING: "Soft furnishing", OTHER: "Other" },
      addLabel: "",
      blank: {},
      columns: [
        { kind: "text", key: "label", label: "Called", wide: true },
        { kind: "toggle", key: "isActive", label: "Offered", on: "Offered", off: "Not offered" },
      ],
    },
    summary: (v) => {
      const a = (Array.isArray(v) ? v : []).map(asRec).filter((r) => r.isActive !== false);
      return a.map((r) => String(r.label)).join(", ") || "None";
    },
  },
  {
    key: "availability.shadowInventory.visibilityRules",
    title: "Who sees rooms kept back",
    about: "Whether each level of staff sees rooms the hotel keeps back from sale.",
    form: {
      kind: "rows",
      label: "Who sees them",
      addLabel: "Add a level",
      word: ["level", "levels"],
      blank: { actorLevel: "L1", visible: false },
      columns: [
        {
          kind: "select",
          key: "actorLevel",
          label: "Who",
          options: [
            { value: "L1", label: "Front desk" },
            { value: "L2", label: "FOM" },
            { value: "L3", label: "GM" },
            { value: "L4", label: "Administrator" },
          ],
        },
        { kind: "toggle", key: "visible", label: "Sees them", on: "Sees them", off: "Does not" },
      ],
    },
    summary: (v) => {
      const WORD: Record<string, string> = { L1: "Front desk", L2: "FOM", L3: "GM", L4: "Administrator" };
      const who = (Array.isArray(v) ? v : []).filter((r) => asRec(r).visible === true).map((r) => WORD[String(asRec(r).actorLevel)] ?? String(asRec(r).actorLevel));
      return who.length ? who.join(", ") : "Nobody";
    },
  },
  {
    key: "availability.bookablePhysicalStates",
    title: "Rooms that can be locked for a booking",
    about: "How a room may stand for a person or the AI to lock it to a booking. A room search goes by dates and does not read this.",
    form: { kind: "multi", label: "Rooms that are", options: CLAIM_STATE_OPTIONS },
  },
  {
    key: "housekeeping.sla.readinessWindowMinutes",
    title: "Time to ready a room for its guest",
    about: "How long housekeeping has to ready a room for the guest coming in. Left empty, the time to clean a room is used.",
    form: minutes(undefined, "Within", 1),
  },
  {
    key: "groupDetection.guestCountThreshold",
    title: "Guests that make a group",
    about: "A booking with this many guests is treated as a group.",
    form: { kind: "number", label: "From", unit: "guests", min: 2, whole: true },
    decidedBy: { policyId: "registry.groupDetection.guestCountThreshold", title: "What counts as a group", read: (p) => `${p.count} guests` },
  },
  {
    key: "billingModel.availablePerSource",
    title: "Who can pay",
    about: "The ways of paying the desk can pick at Set up. Every way ticked on any line is offered on every booking: the lines are not told apart yet. With none ticked, all are offered.",
    form: {
      kind: "map",
      label: "Who can pay",
      keyLabel: "Listed under",
      rows: [
        { key: "LEISURE", label: "Leisure" },
        { key: "CORPORATE", label: "Corporate" },
        { key: "GOVERNMENT", label: "Government" },
      ],
      value: { kind: "multi", label: "Who can pay", options: BILLING_MODEL_OPTIONS },
    },
    summary: (v) => {
      const all = new Set(Object.values(asRec(v)).flatMap((x) => (Array.isArray(x) ? x.map(String) : [])));
      return all.size ? BILLING_MODEL_OPTIONS.filter((o) => all.has(o.value)).map((o) => o.label).join(", ") : "All of them";
    },
  },
  {
    key: "ownership.assignmentRules",
    title: "Who looks after a new inquiry",
    about: "The member of staff a new inquiry is given to, by where it came from. Each source must have someone, or an inquiry from it cannot be started.",
    form: {
      kind: "rows",
      label: "Who looks after it",
      fixedKey: "channel",
      fixedNames: { DIRECT: "Direct", OTA: "Online booking sites", CORPORATE: "Companies", WALK_IN: "Walk-in", AGENT: "Travel agents" },
      addLabel: "",
      blank: {},
      columns: [{ kind: "staff", key: "custodianActorId", label: "Given to" }],
    },
    summary: (v) => `${(Array.isArray(v) ? v : []).length} sources`,
  },
  {
    key: "notification.routing.stageDwell",
    title: "Who is told when a booking waits",
    about: "Who each warning set under Time limits is marked for, under Notifications, Alerts sent. Nobody is sent a message, and everyone signed in sees the same list.",
    form: {
      kind: "map",
      label: "Told",
      keyLabel: "Warning",
      rows: [
        { key: "WARNING", label: "First warning" },
        { key: "CRITICAL", label: "Second warning" },
        { key: "ESCALATION", label: "Escalate" },
      ],
      value: { kind: "multi", label: "Told", options: NOTIFY_OPTIONS },
    },
  },
  {
    key: "notification.routing.operatorExpiry",
    title: "Who is told when a booking lapses",
    about: "Who is told when a clock runs out on a booking.",
    form: { kind: "group", label: "", fields: [{ kind: "multi", key: "DEFAULT", label: "Told", options: NOTIFY_OPTIONS }] },
  },
  {
    key: "handoff.H1.autoFulfil.enabled",
    title: "Accept the Arrival handoff by itself",
    about: "When a booking reaches Arrival, its handoff to the front desk is accepted by itself.",
    form: { kind: "toggle", label: "Accept by itself" },
  },
  {
    key: "ownership.s4.sameTeamAutoFulfilH1",
    title: "Same team, no handoff",
    about: "The handoff made at Reserve counts as done by itself, for a hotel where the same team reserves and receives the guest.",
    form: { kind: "toggle", label: "Count it as done" },
  },
  {
    key: "paymentMilestone.scheduleTemplates",
    title: "Payment schedules",
    about: "Schedules of payments the desk can use at Set up on a group or company booking. Each line falls due this many days from the date the desk gives.",
    form: {
      kind: "map",
      label: "Schedule",
      keyLabel: "Schedule",
      rows: [],
      addLabel: "Add a schedule",
      addPlaceholder: "A short name",
      blank: { label: "", milestones: [] },
      value: {
        kind: "group",
        label: "",
        lines: true,
        fields: [
          { kind: "text", key: "label", label: "Called", optional: true, placeholder: "Deposit then balance" },
          {
            kind: "rows",
            key: "milestones",
            label: "Payments",
            addLabel: "Add a payment",
            word: ["payment", "payments"],
            emptyText: "No payments yet.",
            blank: { code: "", offsetDays: 0 },
            columns: [
              { kind: "text", key: "code", label: "Payment", placeholder: "Deposit" },
              { kind: "number", key: "offsetDays", label: "Days from the date", unit: "days", whole: true },
            ],
          },
        ],
      },
    },
    summary: (v) => {
      const n = Object.keys(asRec(v)).length;
      return n ? `${n} schedule${n === 1 ? "" : "s"}` : "None";
    },
  },
  {
    key: "quotation.document.templateKey",
    title: "Quotation layout name",
    about: "A name recorded with each quotation.",
    unused: "It is kept as a label on each quotation and does not change how it looks.",
    form: { kind: "text", label: "Name", placeholder: "quotation-v1" },
  },
  {
    key: "confirmation.document.templateKey",
    title: "Voucher layout name",
    about: "A name recorded with each confirmation voucher.",
    unused: "It is kept as a label on each voucher and does not change how it looks.",
    form: { kind: "text", label: "Name", placeholder: "confirmation-v1" },
  },
  {
    key: "paymentMilestone.warningOffsetDays",
    title: "Warn before a scheduled payment",
    about: "How many days before a scheduled payment the desk would be warned.",
    unused: LOOKED_AFTER,
    fresh: 0,
    form: days(undefined, "Before", 0),
  },
  {
    key: "overbooking.otaConflictRules",
    title: "Clashes from online booking sites",
    about: "Whether a clash from an online booking site would be checked for.",
    unused: LOOKED_AFTER,
    form: { kind: "group", label: "", fields: [{ kind: "toggle", key: "enabled", label: "Checking is" }] },
  },
]);

// ---- house rules ---------------------------------------------------------------------------------

export type PolicyDef = Draft & { policyClass: string; group: string; defaults: Rec };

const rule = (
  policyId: string,
  policyClass: string,
  group: string,
  title: string,
  about: string,
  fields: SField[],
  defaults: Rec,
  extra: Partial<Draft> = {},
): PolicyDef => ({
  key: policyId,
  policyClass,
  group,
  title,
  about,
  defaults,
  ...extra,
  form: {
    kind: "group",
    label: "",
    lines: true,
    fields: [
      { kind: "toggle", key: "enabled", label: "This rule is" },
      ...(fields.length ? [{ kind: "group", label: "", when: (v: Rec) => v.enabled !== false, fields } as SField] : []),
    ],
  },
});

export const POLICY_GROUPS = ["Time limits", "Reminders and answers", "Money", "Children", "Bookings"] as const;

export const POLICIES: PolicyDef[] = [
  rule("registry.s1Expiry.minutes", "EXPIRY", "Time limits", "An inquiry lapses after", "How long an inquiry can sit with nothing happening before it lapses by itself. While this rule is off, the time under Time limits applies.", [minutes("minutes", "Lapses after", 1)], { minutes: 60 }),
  rule("registry.s2HoldExpiry.minutes", "EXPIRY", "Time limits", "A provisional block lasts", "How long a provisional block marks the rooms at Negotiation before they are let go. While this rule is off, the time under Time limits applies.", [minutes("minutes", "Lasts", 1)], { minutes: 15 }),
  rule("registry.holdExpiry.minutes", "AVAILABILITY", "Time limits", "Rooms stay blocked for", "How long rooms stay blocked at Set up before they are let go, unless the booking has a block time of its own. While this rule is off, the time under Time limits applies.", [minutes("minutes", "Blocked for", 1)], { minutes: 60 }),
  rule("registry.noShow.graceMinutes", "CANCELLATION", "Time limits", "A guest counts as a no-show after", "How long after the guest was expected they count as a no-show. While this rule is off, the time under Daily schedule applies.", [minutes("graceMinutes", "After", 0)], { graceMinutes: 120 }),

  rule("registry.vipArrivalAck.seconds", "COMMUNICATION", "Reminders and answers", "Answering a VIP arrival", "How long staff have to answer a VIP arrival before it is escalated.", [seconds("seconds", "Within", 60)], { seconds: 3600 }),
  rule("registry.handoffAck.seconds", "HANDOFF", "Reminders and answers", "Accepting a handoff", "How long a department has to accept a handoff.", [seconds("h2Seconds", "Housekeeping, within", 60), seconds("h4Seconds", "Before departure, within", 60)], { h2Seconds: 1800, h4Seconds: 1800 }),
  rule("registry.advancePaymentFollowUp.windowSeconds", "PAYMENT", "Reminders and answers", "First reminder about an advance", "How long after the bill goes out the desk gets the first reminder, if the advance has not come in.", [seconds("seconds", "After", 60)], { seconds: 86400 }),
  rule("registry.deficientResolution.deadlineHours", "MAINTENANCE", "Reminders and answers", "Time to fix a fault", "How long housekeeping or maintenance has to put a reported fault right before it is escalated.", [hours("hours", "Time to fix", 1)], { hours: 48 }),
  rule("registry.lostFound.retentionWarning.days", "RETENTION", "Reminders and answers", "Warn before lost property goes", "How many days before lost property reaches the end of its keeping time the desk is warned.", [days("days", "Warn before", 1)], { days: 3 }),

  rule("registry.discount.actorCeiling", "DISCOUNT", "Money", "Discount each person may give", "The most each person may take off a quotation. Above their limit, someone more senior has to generate it.", [{ kind: "percent", key: "l1MaxPercent", label: "Front desk, up to", stored: "whole" }, { kind: "percent", key: "l2MaxPercent", label: "FOM, up to", stored: "whole" }, { kind: "percent", key: "l3MaxPercent", label: "GM, up to", stored: "whole" }], { l1MaxPercent: 5, l2MaxPercent: 15, l3MaxPercent: 100 }),
  rule("registry.creditCeiling.tier2Percent", "CREDIT_CEILING", "Money", "Credit: the FOM must sign off at", "When this much of a guest's credit is used, check-in and new charges wait for the FOM.", [{ kind: "percent", key: "percent", label: "At", stored: "whole", min: 1 }], { percent: 90 }),
  rule("registry.creditCeiling.softGatePercent", "CREDIT_CEILING", "Money", "Credit: extras stop at", "When this much of a guest's credit is used, extras can no longer be charged. Room nights still are. Above 100% lets a guest go over.", [{ kind: "percent", key: "percent", label: "At", stored: "whole", min: 50, max: 200 }], { percent: 100 }),
  rule("registry.creditCeiling.advisoryThresholds", "CREDIT_CEILING", "Money", "Credit: early warnings", "How much of a guest's credit can be used before the desk gets each warning at Stay. These only warn; nothing stops.", [{ kind: "percent", key: "tier1Percent", label: "First warning at", stored: "whole", min: 1 }, { kind: "percent", key: "tier2Percent", label: "Second warning at", stored: "whole", min: 1 }], { tier1Percent: 75, tier2Percent: 90 }),
  rule("registry.groupBooking.advancePaymentBoost", "GROUP_BILLING", "Money", "Groups: a larger advance", "A group's advance is the usual advance times this. 200% asks for twice as much; 100% asks for the same. An amount the desk sets on the booking wins.", [{ kind: "percent", key: "multiplierPercent", label: "Of the usual advance", stored: "whole", min: 100, max: 500, step: 10 }], { multiplierPercent: 200 }),
  rule("registry.groupBooking.creditCeilingBoost", "GROUP_BILLING", "Money", "Groups: more credit suggested", "The credit suggested for a group is the usual figure times this. The person approving still enters the amount.", [{ kind: "percent", key: "multiplierPercent", label: "Of the usual credit", stored: "whole", min: 100, max: 500, step: 10 }], { multiplierPercent: 200 }),
  rule("registry.fomOverride.frequency", "DISPUTE", "Money", "Too many FOM overrides", "The GM is told when the FOM overrides a dispute hold more than this many times in the period.", [{ kind: "number", key: "maxFrequency", label: "More than", unit: "times", min: 1, whole: true }, days("rollingWindowDays", "In any", 1)], { rollingWindowDays: 7, maxFrequency: 3 }),

  rule("registry.child.ageBands", "PRICING", "Children", "Ages of children", "Who counts as a young child and who as a child. Anyone older counts as an adult for beds and meals.", [{ kind: "number", key: "youngChildMaxAge", label: "Young child, up to", unit: "years", min: 0, max: 17, whole: true }, { kind: "number", key: "childMaxAge", label: "Child, up to", unit: "years", min: 0, max: 17, whole: true }], { youngChildMaxAge: 5, childMaxAge: 10 }),
  rule("registry.child.mealPricing", "PRICING", "Children", "What children pay for meals", "The share of the adult meal price each age pays. The room rate is not touched.", [{ kind: "percent", key: "youngChildPercent", label: "Young child", stored: "whole", step: 5 }, { kind: "percent", key: "childPercent", label: "Child", stored: "whole", step: 5 }, { kind: "percent", key: "adultPercent", label: "Adult", stored: "whole", step: 5 }], { youngChildPercent: 0, childPercent: 70, adultPercent: 100 }),
  rule(
    "registry.child.separateBedCharge",
    "PRICING",
    "Children",
    "A separate bed for a child",
    "What would be charged when a child has their own bed instead of sharing.",
    [
      { kind: "choice", key: "basis", label: "The charge is", options: [{ value: "FLAT", label: "A set amount" }, { value: "PERCENT_OF_ROOM", label: "A share of the room price" }] },
      { kind: "group", label: "", when: (v) => v.basis !== "PERCENT_OF_ROOM", fields: [{ kind: "money", key: "amount", label: "Amount" }] },
      { kind: "group", label: "", when: (v) => v.basis === "PERCENT_OF_ROOM", fields: [{ kind: "percent", key: "amount", label: "Of the room price", stored: "whole" }] },
    ],
    { basis: "FLAT", amount: 0, currency: "BTN" },
    { unused: "Pricing does not charge this yet, so a child's own bed stays free whatever is set here." },
  ),
  rule("registry.child.unaccompaniedMinorMinAge", "COMPLIANCE", "Children", "Youngest guest without an adult", "A guest younger than this cannot have a room without a responsible adult. The inquiry is refused.", [{ kind: "number", key: "minimumAge", label: "From", unit: "years", min: 0, max: 25, whole: true }], { minimumAge: 18 }),
  rule("registry.child.adultToChildRatio", "OCCUPANCY", "Children", "Children for each adult", "A warning when a booking has more children than this for each adult.", [{ kind: "number", key: "maxChildrenPerAdult", label: "At most", unit: "children", min: 1, whole: true }], { maxChildrenPerAdult: 3 }),

  rule("registry.duplicateInquiry.blockS1Exit", "DUPLICATE_DETECTION", "Bookings", "Hold a possible duplicate", "A booking flagged as a possible duplicate cannot leave Inquiry until the flag is answered.", [], {}),
  rule(
    "registry.groupDetection.guestCountThreshold",
    "GROUP_DETECTION",
    "Bookings",
    "What counts as a group",
    "A booking with this many guests is treated as a group. The switches say who is counted.",
    [
      { kind: "number", key: "count", label: "From", unit: "guests", min: 2, whole: true },
      { kind: "toggle", key: "includeAdults", label: "Adults", on: "Counted", off: "Not counted" },
      { kind: "toggle", key: "includeChildren", label: "Children", on: "Counted", off: "Not counted" },
      { kind: "toggle", key: "includeYoungChildren", label: "Young children", on: "Counted", off: "Not counted" },
    ],
    { count: 6, includeAdults: true, includeChildren: true, includeYoungChildren: false },
  ),
  rule(
    "registry.vip.notificationRoutingPerTier",
    "VIP_NOTIFICATION",
    "Bookings",
    "Who is told when a VIP arrives",
    "Who has to be told, by the guest's VIP level, before a VIP can check in. A level with no line uses Any other level.",
    [
      {
        kind: "map",
        key: "tiers",
        label: "Told",
        keyLabel: "VIP level",
        rows: [{ key: "DEFAULT", label: "Any other level" }],
        addLabel: "Add a level",
        addPlaceholder: "PLATINUM",
        blank: ["FOM"],
        value: { kind: "multi", label: "Told", options: VIP_OPTIONS },
      },
    ],
    { tiers: { DEFAULT: ["FOM", "GM"] } },
  ),
  rule("registry.shadowInventory.l4Only", "AVAILABILITY", "Bookings", "Hide rooms kept back", "Rooms kept back from sale would be seen only in the admin console.", [], {}, { unused: 'Nothing reads this rule yet. Who sees those rooms is set by "Who sees rooms kept back" under Other settings.' }),
];

const VIP_CONFIG = page("/admin/vip-routing", "VIP arrivals", [
  {
    key: "vipNotification.routingPerTier",
    title: "Who is told, when the rule is off",
    about: "Who is told when a VIP arrives, while the house rule is off.",
    form: {
      kind: "map",
      label: "Told",
      keyLabel: "VIP level",
      rows: [{ key: "DEFAULT", label: "Any other level" }],
      addLabel: "Add a level",
      addPlaceholder: "PLATINUM",
      blank: ["FOM"],
      value: { kind: "multi", label: "Told", options: VIP_OPTIONS },
    },
    decidedBy: { policyId: "registry.vip.notificationRoutingPerTier", title: "Who is told when a VIP arrives" },
  },
]);

// ---- lookups -------------------------------------------------------------------------------------

const POLICY_PAGE = { href: "/admin/policies", title: "House rules" };

const ALL: SettingDef[] = [
  ...TIME_LIMITS,
  ...FINANCIAL,
  ...OPERATIONAL,
  ...COMMERCIAL,
  ...CANCELLATION,
  ...COMMUNICATION,
  ...OTA,
  ...AI,
  ...POST_STAY,
  ...MESSAGES,
  ...OTHER,
  ...VIP_CONFIG,
  ...POLICIES.map((p) => ({ ...p, page: POLICY_PAGE.href, pageTitle: POLICY_PAGE.title })),
];

const BY_KEY = new Map(ALL.map((d) => [d.key, d]));
const POLICY_BY_KEY = new Map(POLICIES.map((p) => [p.key, p]));

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function getPolicyDef(key: string): PolicyDef | undefined {
  return POLICY_BY_KEY.get(key);
}

/** The settings a page shows, in order. */
export const keysOf = (defs: SettingDef[]) => defs.map((d) => d.key);

export const PAGE_KEYS = {
  timeLimits: keysOf(TIME_LIMITS),
  financial: keysOf(FINANCIAL),
  operational: keysOf(OPERATIONAL),
  commercial: keysOf(COMMERCIAL),
  cancellation: keysOf(CANCELLATION),
  communication: keysOf(COMMUNICATION),
  ota: keysOf(OTA),
  ai: keysOf(AI),
  postStay: keysOf(POST_STAY),
  handoffs: keysOf(MESSAGES),
  other: keysOf(OTHER),
  vip: keysOf(VIP_CONFIG),
};

/** Every setting and rule, for the side list's search. */
export function settingsIndex(): { key: string; title: string; about: string; page: string; pageTitle: string }[] {
  return ALL.map(({ key, title, about, page: p, pageTitle }) => ({ key, title, about, page: p, pageTitle }));
}
