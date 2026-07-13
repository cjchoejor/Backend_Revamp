import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedRow = {
  policyId: string;
  policyClass: string;
  definition: Record<string, unknown>;
};

const ADDITIONS: SeedRow[] = [
  {
    policyId: "registry.holdExpiry.minutes",
    policyClass: "AVAILABILITY",
    definition: {
      enabled: true,
      description: "S3 committed-hold expiry in minutes — overrides ConfigurationEntry expiry.s3.committedHoldTtlSeconds.",
      minutes: 60,
    },
  },
  {
    policyId: "registry.discount.actorCeiling",
    policyClass: "DISCOUNT",
    definition: {
      enabled: true,
      description: "Per-actor discount ceilings — overrides discount.fom.maxPercentage / discount.gm.maxPercentage.",
      l1MaxPercent: 5,
      l2MaxPercent: 15,
      l3MaxPercent: 100,
    },
  },
  {
    policyId: "registry.vipArrivalAck.seconds",
    policyClass: "COMMUNICATION",
    definition: {
      enabled: true,
      description: "VIP arrival acknowledgement window in seconds — overrides acknowledgement.windowPerType.vipArrival.",
      seconds: 3600,
    },
  },
  {
    policyId: "registry.deficientResolution.deadlineHours",
    policyClass: "MAINTENANCE",
    definition: {
      enabled: true,
      description: "Hours given to resolve a deficient condition — overrides deficientResolution.deadlineHours.",
      hours: 48,
    },
  },
  {
    policyId: "registry.handoffAck.seconds",
    policyClass: "HANDOFF",
    definition: {
      enabled: true,
      description: "H2 / H4 handoff ack windows in seconds — overrides acknowledgement.windowPerType.h2 / .h4.",
      h2Seconds: 1800,
      h4Seconds: 1800,
    },
  },
  {
    policyId: "registry.fomOverride.frequency",
    policyClass: "DISPUTE",
    definition: {
      enabled: true,
      description: "Rolling window / cap for W33 FOM override frequency notice — overrides fomOverride.frequency.",
      rollingWindowDays: 7,
      maxFrequency: 3,
    },
  },
  {
    policyId: "registry.s1Expiry.minutes",
    policyClass: "EXPIRY",
    definition: {
      enabled: true,
      description: "S1 inquiry expiry minutes — overrides expiry.s1.defaultTtlSeconds.DEFAULT.",
      minutes: 60,
    },
  },
  {
    policyId: "registry.s2HoldExpiry.minutes",
    policyClass: "EXPIRY",
    definition: {
      enabled: true,
      description: "S2 speculative hold TTL in minutes — overrides expiry.s2.speculativeHoldTtlSeconds.",
      minutes: 15,
    },
  },
  {
    policyId: "registry.quotationValidity.days",
    policyClass: "EXPIRY",
    definition: {
      enabled: true,
      description: "Default quotation validity in days — overrides expiry.s2.quotationValidityDays.",
      days: 7,
    },
  },
  {
    policyId: "registry.advancePaymentFollowUp.windowSeconds",
    policyClass: "PAYMENT",
    definition: {
      enabled: true,
      description: "W34 advance-payment follow-up window in seconds — overrides advancePayment.followUpWindowSeconds.",
      seconds: 86400,
    },
  },
  {
    policyId: "registry.groupDetection.guestCountThreshold",
    policyClass: "GROUP_DETECTION",
    definition: {
      enabled: true,
      description: "Guest count at which to auto-route an entry to group billing — overrides groupDetection.guestCountThreshold. Include flags below decide which age bands count toward the threshold: adults + pricing-children (6-10) by default; young children (0-5) excluded so a family of 2 adults + 8 toddlers isn't misclassified as a group.",
      count: 6,
      includeAdults: true,
      includeChildren: true,
      includeYoungChildren: false,
    },
  },
  {
    policyId: "registry.groupBooking.advancePaymentBoost",
    policyClass: "GROUP_BILLING",
    definition: {
      enabled: true,
      description: "For entries classified as GROUP_MASTER (Policy 64), multiply the required advance payment by this percentage. 200 = 2x the DEFAULT threshold amount, 150 = 1.5x, 100 = no boost. Falls back to no boost when disabled.",
      multiplierPercent: 200,
    },
  },
  {
    policyId: "registry.groupBooking.creditCeilingBoost",
    policyClass: "GROUP_BILLING",
    definition: {
      enabled: true,
      description: "For entries classified as GROUP_MASTER, boost the recommended credit ceiling by this percentage. A group of 20 rooms has higher expected total than a single guest and warrants a proportionally higher ceiling. 200 = 2x the base tier value. Advisory — the human approver still enters an explicit amount, but the recommendation now reflects group scale.",
      multiplierPercent: 200,
    },
  },
  {
    policyId: "registry.creditCeiling.tier2Percent",
    policyClass: "CREDIT_CEILING",
    definition: {
      enabled: true,
      description: "Credit-ceiling Tier 2 gate (percent of ceiling). Consulted by p44 (check-in gate) and p45 (charge-posting gate).",
      percent: 90,
    },
  },
  {
    policyId: "registry.creditCeiling.softGatePercent",
    policyClass: "CREDIT_CEILING",
    definition: {
      enabled: true,
      description: "Credit-ceiling soft-gate ratio above which non-mandatory charges are blocked. Previously hardcoded at 100.",
      percent: 100,
    },
  },
  {
    policyId: "registry.creditCeiling.advisoryThresholds",
    policyClass: "CREDIT_CEILING",
    definition: {
      enabled: true,
      description: "Advisory (W12) percentages — overrides creditCeiling.proximityThresholds.{tier1Percent, tier2Percent}.",
      tier1Percent: 75,
      tier2Percent: 90,
    },
  },
  {
    policyId: "registry.lostFound.retentionWarning.days",
    policyClass: "RETENTION",
    definition: {
      enabled: true,
      description: "Days before retention expiry that W30 emits the approaching-expiry trace.",
      days: 3,
    },
  },
  {
    policyId: "registry.vip.notificationRoutingPerTier",
    policyClass: "VIP_NOTIFICATION",
    definition: {
      enabled: true,
      description:
        "Per-VIP-tier list of roles to notify at S5→S6 (SIG-S6 §9, blocking for S6_READINESS). Overrides ConfigurationEntry vipNotification.routingPerTier.",
      tiers: { DEFAULT: ["FOM", "GM"] },
    },
  },
];

for (const row of ADDITIONS) {
  const existing = await prisma.policyRegistry.findFirst({
    where: { policyId: row.policyId, isActive: true },
    orderBy: { version: "desc" },
  });
  if (existing) {
    console.log(`  - ${row.policyId} already present (v${existing.version}); skipping.`);
    continue;
  }
  const created = await prisma.policyRegistry.create({
    data: {
      policyId: row.policyId,
      policyClass: row.policyClass,
      policyDefinition: row.definition,
      version: 1,
      isActive: true,
      createdBy: "actor-seed-system",
    },
  });
  console.log(`  + ${row.policyId} created (v${created.version})`);
}

await prisma.$disconnect();
