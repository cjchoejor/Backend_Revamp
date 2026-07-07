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
