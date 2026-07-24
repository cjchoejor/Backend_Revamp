import type { Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { requiredControlCheck } from "../../lib/admin/required-control-check.js";

async function readActive(prisma: PrismaClient, key: string) {
  const row = await getActiveConfigEntry(prisma, key);
  return row?.configValue ?? null;
}
function setKey(prisma: PrismaClient, key: string, value: Prisma.InputJsonValue, actorId: string, notes?: string | null) {
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: key, configValue: value, actorId, notes }));
}

export async function getSourceFlagConfig(prisma: PrismaClient) {
  return readActive(prisma, "ota.sourceFlagConfig");
}
export async function setSourceFlagConfig(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "ota.sourceFlagConfig", value, actorId);
}

export async function getPollingInterval(prisma: PrismaClient) {
  return readActive(prisma, "ota.inbox.pollingIntervalSeconds");
}
export async function setPollingInterval(prisma: PrismaClient, seconds: number, actorId: string) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ValidationError("Polling interval must be a positive number of seconds");
  return setKey(prisma, "ota.inbox.pollingIntervalSeconds", seconds, actorId);
}

export async function getConflictTriggerRules(prisma: PrismaClient) {
  return readActive(prisma, "ota.conflictTriggerRules");
}
export async function setConflictTriggerRules(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "ota.conflictTriggerRules", value, actorId);
}

export async function getNoShowCutoff(prisma: PrismaClient) {
  return readActive(prisma, "noShow.cutoffMinutes");
}
export async function setNoShowCutoff(prisma: PrismaClient, minutes: number, actorId: string) {
  if (!Number.isFinite(minutes) || minutes < 0) throw new ValidationError("No-show cutoff must be a non-negative number of minutes");
  return setKey(prisma, "noShow.cutoffMinutes", minutes, actorId);
}

export async function getNoShowPenaltyStructure(prisma: PrismaClient) {
  return readActive(prisma, "noShow.penaltyStructure");
}
export async function setNoShowPenaltyStructure(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  await requiredControlCheck({ surfaceName: "no_show_penalty_structure", proposedChange: value, operationType: "UPDATE", actorId });
  return setKey(prisma, "noShow.penaltyStructure", value, actorId);
}
