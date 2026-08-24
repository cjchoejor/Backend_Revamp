import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ADDITIONS: { key: string; value: unknown; notes: string }[] = [
  {
    key: "deficientResolution.deadlineHours",
    value: 48,
    notes: "W10 — default hours given to housekeeping/maintenance to resolve a deficient condition.",
  },
  {
    key: "lostFound.retention.warningOffsetDays",
    value: 3,
    notes: "W30 — days before a Lost & Found item's retention expiry that the approaching-expiry trace fires.",
  },
  {
    key: "interimPayment.schedule",
    value: { enabled: true, everyNights: 7, minimumOutstanding: 0 },
    notes:
      "Interim payments on long stays (2026-08-21): the night audit raises an 'interim payment due' prompt every `everyNights` nights slept when the outstanding balance is at least `minimumOutstanding`; manual requests are always possible. enabled=false turns the prompt off.",
  },
  {
    key: "interimPayment.reminder",
    value: { enabled: true, dueAfterHours: 24, extensionLeadHours: 6, repeatEveryHours: 24, maxReminders: 5 },
    notes:
      "Mid-stay payment reminder (2026-08-22): every interim bill carries a due-by (long stay: `dueAfterHours` after the bill; extension: `extensionLeadHours` before the held nights lapse) and the W41 clock fires there while unpaid — a reminder on the booking, re-armed every `repeatEveryHours` up to `maxReminders`. enabled=false arms no clock.",
  },
  {
    key: "stayExtension.holdTtlSeconds",
    value: 86400,
    notes:
      "Stay extension (2026-08-21): how long the extra nights stay claimed while the interim payment comes in; W40 releases them when it runs out unpaid.",
  },
  {
    key: "earlyDeparture.penalty",
    value: { basis: "UNSTAYED_NIGHTS", nights: 1, percent: 100, amount: 0, perRatePlan: {} },
    notes:
      "Early departure fee (2026-08-22, Policy 36): basis NONE | FLAT_AMOUNT (amount, net) | UNSTAYED_NIGHTS (up to nights unstayed nights at the frozen per-night room figure x percent/100) | PERCENT_OF_UNSTAYED (percent of every unstayed night frozen room figure); perRatePlan overrides by rate plan id. Posted on the live folio as a SERVICE charge; the GM may waive it.",
  },
  {
    key: "expiry.parking.followUpDays",
    value: 30,
    notes:
      "Entry park-expiry threshold, 30 days from park date (DEV-SPEC-001 Part 13 §Seeded Defaults). Park arms a PARKING_FOLLOW_UP ENTRY_EXPIRY job at this offset in place of the short stage-expiry timer (SIG-S1 §3.4). Was read by s1-entry-service but never seeded — the code silently fell back to its hardcoded 30-day default, so the 'configurable' threshold wasn't.",
  },
  // Communication channels (ACIG §6.2.16) — the Channels admin page renders empty without this.
  {
    key: "communication.channels",
    value: {
      EMAIL: { enabled: true, displayName: "Email", transport: "EMAIL" },
      WHATSAPP: { enabled: false, displayName: "WhatsApp", transport: "WHATSAPP" },
      PHONE: { enabled: true, displayName: "Phone", transport: "VOICE" },
      FRONT_DESK: { enabled: true, displayName: "Front desk", transport: "IN_PERSON" },
    },
    notes: "Admin-editable communication channel map — Channels page is empty without it.",
  },
  // Operational keys exposed by /admin/operational that lacked seeded defaults.
  {
    key: "checkout.cutoffTime",
    value: "12:00",
    notes: "W26 — time of day (HH:MM, hotel local) after which late-checkout escalation timers fire.",
  },
  {
    key: "roomAssignment.priorityRules",
    value: [],
    notes:
      "Operator-ordered list of room assignment priority rules. Empty array = system uses default first-fit ordering.",
  },
  {
    key: "nightAudit.expectedChargesRules",
    value: {},
    notes: "Night audit rules for expected daily charges by line type. Empty object = no per-type expectations enforced.",
  },
  // OTA config (ACIG §6.2.23) — keys the /admin/ota-config page reads but that were never seeded.
  // NOTE: these are the exact keys OTAConfigService reads; the seed also carries the similarly-named
  // `ota_email_poll_interval_seconds` and `noShow.cutoffWindowMinutes`, which are read elsewhere.
  {
    key: "ota.inbox.pollingIntervalSeconds",
    value: 300,
    notes: "W7 OTA inbox poll cadence (seconds). 300 = 5 minutes. Read by OTAConfigService / /admin/ota-config.",
  },
  {
    key: "ota.conflictTriggerRules",
    value: { detectDoubleBooking: true, detectDateOverlap: true, detectRateMismatch: true },
    notes: "Rules used to flag OTA conflict overbookings.",
  },
  {
    key: "noShow.cutoffMinutes",
    value: 120,
    notes: "Per-OTA-channel no-show cutoff (minutes after expected arrival before no-show treatment fires).",
  },
  // Billing rates (FinancialConfigurationService) — GST is compound: 5% of (net + service
  // charge), the same base every engine already uses (room-composition, compute-stay-charges,
  // S7/S8 charge posting, invoice rendering). serviceChargeRate was never seeded at all, and
  // salesTaxRate was seeded 0 (GST off) until 2026-08-03 — this script only CREATES missing
  // keys, so an existing DB with the old 0 row needs a supersede via /admin/financial instead.
  {
    key: "billing.salesTaxRate",
    value: 0.05,
    notes: "GST 5% — compound, applied to (net value + service charge) everywhere (quotes, charge posting, invoices).",
  },
  {
    key: "billing.serviceChargeRate",
    value: 0.1,
    notes: "Service charge 10% of net value. GST is computed on top of (net + this).",
  },
  {
    key: "noShow.penaltyStructure",
    value: {
      DEFAULT: { penaltyPercent: 100 },
      OTA: { penaltyPercent: 100 },
      DIRECT: { penaltyPercent: 100 },
      AGENT: { penaltyPercent: 100 },
      CORPORATE: { penaltyPercent: 100 },
    },
    notes: "No-show penalty % by booking source (default full advance forfeiture). Operational no-show currently derives from the cancellation same-day tier; this is the admin surface per ACIG §6.2.23.",
  },
];

for (const row of ADDITIONS) {
  const existing = await prisma.configurationEntry.findFirst({
    where: { configKey: row.key, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  if (existing) {
    console.log(`  - ${row.key} already present (value=${JSON.stringify(existing.configValue)}); skipping.`);
    continue;
  }
  const created = await prisma.configurationEntry.create({
    data: {
      configKey: row.key,
      configValue: row.value as any,
      effectiveFrom: new Date(),
      setBy: "actor-seed-system",
      notes: row.notes,
    },
  });
  console.log(`  + ${row.key} created (value=${JSON.stringify(created.configValue)})`);
}

await prisma.$disconnect();
