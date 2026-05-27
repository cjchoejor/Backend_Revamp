import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { isSystemSeedSetBy, supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

export const FINANCIAL_CONFIG_KEYS = [
  "advancePayment.thresholds",
  "advancePayment.followUpWindowSeconds",
  "advancePayment.escalationWindowSeconds",
  "payment.followUp.intervals",
  "payment.followUp.ttlDays",
  "invoice.templates",
  "invoice.templates.final",
  "invoice.templates.proforma",
  "damage.rateList",
  "dispute.sla",
  "fomOverride.frequency",
  "writeOff.authority.thresholds",
] as const;

export type FinancialConfigKey = (typeof FINANCIAL_CONFIG_KEYS)[number];

export async function listFinancialConfigKeys() {
  return [...FINANCIAL_CONFIG_KEYS];
}

export async function getFinancialConfig(prisma: PrismaClient, configKey: FinancialConfigKey) {
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

export async function setFinancialConfig(
  prisma: PrismaClient,
  configKey: FinancialConfigKey,
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
