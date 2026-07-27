import { PrismaClient } from "@prisma/client";
import { ADDITIONAL_REGISTRY_POLICIES, ADDITIONAL_CONFIG_KEYS } from "../prisma/additional-registry-seed-data.js";

const prisma = new PrismaClient();

for (const row of ADDITIONAL_REGISTRY_POLICIES) {
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

// Base timers-workers fallback config keys (idempotent — skips if an active row exists).
for (const { configKey, configValue, notes } of ADDITIONAL_CONFIG_KEYS) {
  const existing = await prisma.configurationEntry.findFirst({
    where: { configKey, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  if (existing) {
    console.log(`  - ${configKey} already active; skipping.`);
    continue;
  }
  await prisma.configurationEntry.create({
    data: { configKey, configValue: configValue as any, setBy: "actor-seed-system", notes },
  });
  console.log(`  + ${configKey} created (=${JSON.stringify(configValue)})`);
}

await prisma.$disconnect();
