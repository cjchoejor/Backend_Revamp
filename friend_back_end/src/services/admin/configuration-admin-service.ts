import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { isSystemSeedSetBy, supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { getConfigKeyMeta, ownerSurfaceHint } from "../../lib/admin/config-key-registry.js";

const FORBIDDEN_ZERO_KEYS = new Set([
  "expiry.s3.committedHoldTtlSeconds",
  "expiry.s2.speculativeHoldTtlSeconds",
  "expiry.s1.defaultTtlSeconds",
]);

// When true, the generic ConfigurationService rejects keys with no registered validator
// (full ACIG §6.2.25 strictness). Default lenient to preserve open-ended config writes.
const STRICT_CONFIG_KEYS = process.env.ADMIN_STRICT_CONFIG_KEYS === "true";

/**
 * ACIG §6.2.25 — the generic ConfigurationService enforces key ownership and shape validation.
 * Keys owned by a domain service must be written through that service's dedicated surface.
 */
function assertConfigValueAllowed(configKey: string, value: unknown) {
  const meta = getConfigKeyMeta(configKey);

  if (!meta) {
    if (STRICT_CONFIG_KEYS) {
      throw new ValidationError(`Unknown configuration key "${configKey}" — no registered validator`);
    }
  } else {
    if (meta.owner !== "ConfigurationService") {
      const hint = ownerSurfaceHint(meta.owner);
      throw new ValidationError(
        `Configuration key "${configKey}" is owned by ${meta.owner}` +
          (hint ? ` — use its dedicated surface (${hint})` : "") +
          " rather than the generic configuration route",
      );
    }
    if (meta.validate) {
      const error = meta.validate(value);
      if (error) throw new ValidationError(`${configKey} ${error}`);
    }
  }

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
