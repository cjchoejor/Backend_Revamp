import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { isSystemSeedSetBy, supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

const FORBIDDEN_ZERO_KEYS = new Set([
  "expiry.s3.committedHoldTtlSeconds",
  "expiry.s2.speculativeHoldTtlSeconds",
  "expiry.s1.defaultTtlSeconds",
]);

function assertConfigValueAllowed(configKey: string, value: unknown) {
  if (FORBIDDEN_ZERO_KEYS.has(configKey)) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n) && n <= 0) {
      throw new ValidationError(`${configKey} must be a positive number`);
    }
  }
}

export async function listConfigurationKeys(prisma: PrismaClient) {
  const rows = await prisma.configurationEntry.findMany({
    distinct: ["configKey"],
    select: { configKey: true },
    orderBy: { configKey: "asc" },
  });
  return rows.map((r) => r.configKey);
}

export async function getActiveConfiguration(prisma: PrismaClient, configKey: string) {
  const row = await getActiveConfigEntry(prisma, configKey);
  if (!row) throw new NotFoundError("ConfigurationEntry");
  return {
    id: row.id,
    configKey: row.configKey,
    configValue: row.configValue,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    setBy: row.setBy,
    setAt: row.setAt,
    notes: row.notes,
    isSystemDefault: isSystemSeedSetBy(row.setBy),
  };
}

export async function listConfigurationHistory(prisma: PrismaClient, configKey: string, limit = 20) {
  return prisma.configurationEntry.findMany({
    where: { configKey },
    orderBy: { effectiveFrom: "desc" },
    take: Math.min(limit, 100),
  });
}

export async function setConfiguration(
  prisma: PrismaClient,
  input: { configKey: string; configValue: Prisma.InputJsonValue; actorId: string; notes?: string | null },
) {
  assertConfigValueAllowed(input.configKey, input.configValue);
  return prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey: input.configKey,
      configValue: input.configValue,
      actorId: input.actorId,
      notes: input.notes,
    }),
  );
}
