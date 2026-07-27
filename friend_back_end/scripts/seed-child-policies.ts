/**
 * Seeds the 5 child-policy registry rows that the front-desk applies during S1 intake / S2
 * quotation pricing. All values are configurable via the admin policy editor — defaults here
 * come from docs/Legphel-Child-Policy.md but the hotel can change them at any time without a
 * code deploy. Idempotent: rows that already exist are skipped.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedRow = {
  policyId: string;
  policyClass: string;
  definition: Record<string, unknown>;
};

const ADDITIONS: SeedRow[] = [
  {
    policyId: "registry.child.ageBands",
    policyClass: "PRICING",
    definition: {
      enabled: true,
      description:
        "Age bands used to classify each guest at booking / check-in. Young child = 0..youngChildMaxAge inclusive; Child = (youngChildMaxAge+1)..childMaxAge inclusive; Adult = childMaxAge+1 and above. Per the Legphel-Child-Policy.md defaults: under 6 / 6–10 / 11+.",
      youngChildMaxAge: 5,
      childMaxAge: 10,
    },
  },
  {
    policyId: "registry.child.mealPricing",
    policyClass: "PRICING",
    definition: {
      enabled: true,
      description:
        "Percentage of the adult meal rate applied per age band. youngChildPercent = 0 (free), childPercent = 70 (70% of adult), adultPercent = 100. Applies to the meal component of any meal plan or package — room rate is handled separately by the bed-charge rules.",
      youngChildPercent: 0,
      childPercent: 70,
      adultPercent: 100,
    },
  },
  {
    policyId: "registry.child.separateBedCharge",
    policyClass: "PRICING",
    definition: {
      enabled: false,
      description:
        "Charge applied when a child under the adult-age band requests a separate bed instead of sharing parents' bedding. Open hotel decision (Legphel-Child-Policy.md §2). basis = FLAT|PERCENT_OF_ROOM. amount = flat money OR percent. Currency only used when basis = FLAT. While enabled=false the child stays free regardless of bed arrangement.",
      basis: "FLAT",
      amount: 0,
      currency: "BTN",
    },
  },
  {
    policyId: "registry.child.unaccompaniedMinorMinAge",
    policyClass: "COMPLIANCE",
    definition: {
      enabled: true,
      description:
        "Minimum age at which a guest may book or occupy a room without a responsible adult (Legphel-Child-Policy.md §6). Bookings that violate this raise a hard block at S1. Set enabled=false to disable the check.",
      minimumAge: 18,
    },
  },
  {
    policyId: "registry.child.adultToChildRatio",
    policyClass: "OCCUPANCY",
    definition: {
      enabled: false,
      description:
        "Optional cap: at most maxChildrenPerAdult children for each accompanying adult. Used by the capacity validator when special situations (one adult with many children) need policing. Disable to skip the check.",
      maxChildrenPerAdult: 3,
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
