import type { Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { maskSecrets, mergePreservingSecrets } from "../../lib/admin/mask-secrets.js";

const AGENT_CONFIG_KEY = "ai.agentConfig";
const PROCESSING_LOCK_KEY = "processingLock.ttl.perChannel";
const VOICE_SLA_KEY = "voiceNote.reviewSlaPerChannel";
const VOICE_ESCALATION_KEY = "voiceNote.escalationRouting";

const PROCESSING_LOCK_CHANNELS = ["EMAIL_AI", "WHATSAPP_AI", "FRONT_DESK", "PHONE"];
const TRUST_LEVELS = new Set(["ALWAYS_REQUIRE_APPROVAL", "AUTO_APPROVE_HIGH_CONFIDENCE", "FULL_AUTO"]);

async function readActive(prisma: PrismaClient, key: string) {
  const row = await getActiveConfigEntry(prisma, key);
  return row?.configValue ?? null;
}

export async function getAIAgentConfig(prisma: PrismaClient) {
  const value = await readActive(prisma, AGENT_CONFIG_KEY);
  return value ? maskSecrets(value) : null;
}

export async function updateAIAgentConfig(prisma: PrismaClient, input: Record<string, unknown>, actorId: string) {
  // Validate trust levels per intent category, if provided.
  const trustLevels = (input.trustLevels ?? {}) as Record<string, unknown>;
  for (const [category, value] of Object.entries(trustLevels)) {
    const level = typeof value === "string" ? value : (value as any)?.trustLevel;
    if (level && !TRUST_LEVELS.has(level)) {
      throw new ValidationError(`Invalid trust level "${level}" for intent category "${category}"`);
    }
  }

  const stored = await readActive(prisma, AGENT_CONFIG_KEY);
  const merged = mergePreservingSecrets(input, stored);

  return prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, {
      configKey: AGENT_CONFIG_KEY,
      configValue: merged as Prisma.InputJsonValue,
      actorId,
      notes: "AI agent configuration updated",
    });
    return maskSecrets(merged);
  });
}

export async function getProcessingLockTTLs(prisma: PrismaClient) {
  return readActive(prisma, PROCESSING_LOCK_KEY);
}

export async function setProcessingLockTTLs(prisma: PrismaClient, value: Record<string, unknown>, actorId: string) {
  for (const ch of PROCESSING_LOCK_CHANNELS) {
    if (value[ch] === undefined || value[ch] === null) {
      throw new ValidationError(`Processing lock TTL missing for channel "${ch}" — all four channels required`);
    }
    if (typeof value[ch] === "number" && (value[ch] as number) <= 0) {
      throw new ValidationError(`Processing lock TTL for "${ch}" must be positive`);
    }
  }
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: PROCESSING_LOCK_KEY, configValue: value as Prisma.InputJsonValue, actorId }));
}

export async function getVoiceNoteSLAs(prisma: PrismaClient) {
  return readActive(prisma, VOICE_SLA_KEY);
}
export async function setVoiceNoteSLAs(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: VOICE_SLA_KEY, configValue: value, actorId }));
}

export async function getVoiceNoteEscalationRouting(prisma: PrismaClient) {
  return readActive(prisma, VOICE_ESCALATION_KEY);
}
export async function setVoiceNoteEscalationRouting(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: VOICE_ESCALATION_KEY, configValue: value, actorId }));
}
