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
