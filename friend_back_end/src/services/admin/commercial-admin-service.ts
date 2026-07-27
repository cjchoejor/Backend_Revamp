import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { isSystemSeedSetBy, supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

/** Curated commercial configuration keys (ACIG Domain 03). */
/**
 * CommercialThresholdService-owned keys per ACIG §6.2.11. `cancellation.policyTiers` is owned by
 * CancellationPolicyService — surface it on /admin/cancellation-policies or the generic
 * Configuration page, not here. `pricing.ratePlans` is legacy (replaced by rate_plan_registry).
 */
export const COMMERCIAL_CONFIG_KEYS = [
  "discount.fom.maxPercentage",
  "discount.gm.maxPercentage",
  "creditCeiling.clientTier.thresholds",
  "creditCeiling.proximityThresholds",
  "foc.configuration",
  "overbooking.maxAllowedRooms",
  "confirmation.authorityThresholds",
  "speculativeHold.placementThresholds",
  "writeOff.authority.thresholds",
] as const;

export type CommercialConfigKey = (typeof COMMERCIAL_CONFIG_KEYS)[number];

export async function listCommercialConfigKeys() {
  return [...COMMERCIAL_CONFIG_KEYS];
}

export async function getCommercialConfig(prisma: PrismaClient, configKey: CommercialConfigKey) {
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

export async function setCommercialConfig(
  prisma: PrismaClient,
  configKey: CommercialConfigKey,
  configValue: Prisma.InputJsonValue,
  actorId: string,
  notes?: string | null,
) {
  return prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey,
      configValue,
      actorId,
      notes,
    }),
  );
}
