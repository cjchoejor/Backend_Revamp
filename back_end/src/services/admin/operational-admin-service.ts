import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { isSystemSeedSetBy, supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

export const OPERATIONAL_CONFIG_KEYS = [
  "nightAudit.scheduleTime",
  "nightAudit.schedule",
  "nightAudit.expectedChargesRules",
  "nightAudit.expectedDailyFAndBCharge",
  "checkout.cutoffTime",
  "roomAssignment.priorityRules",
  "housekeeping.sla.windowMinutes",
  "inspection.postCheckout.windowHours",
  "room.readiness.slaWindow",
  "noShow.cutoffWindowMinutes",
] as const;

export type OperationalConfigKey = (typeof OPERATIONAL_CONFIG_KEYS)[number];

export async function listOperationalConfigKeys() {
  return [...OPERATIONAL_CONFIG_KEYS];
}

export async function getOperationalConfig(prisma: PrismaClient, configKey: OperationalConfigKey) {
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

export async function setOperationalConfig(
  prisma: PrismaClient,
  configKey: OperationalConfigKey,
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
