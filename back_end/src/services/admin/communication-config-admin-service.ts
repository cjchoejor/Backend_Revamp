import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { maskSecrets, mergePreservingSecrets } from "../../lib/admin/mask-secrets.js";
import { GUEST_REPLY_SETTINGS } from "../../lib/guest-reply-settings.js";

const CHANNELS_KEY = "communication.channels";
const ACK_WINDOW_KEY = "acknowledgement.windowPerType";

/**
 * ACIG §6.2.16 — channel config (credentials stored as secrets, never returned after save).
 * Channels are stored as a JSON map keyed by channel id under `communication.channels`.
 */
export async function listChannels(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, CHANNELS_KEY);
  const channels = (row?.configValue as Record<string, unknown>) ?? {};
  return maskSecrets(channels);
}

export async function getChannel(prisma: PrismaClient, channelId: string) {
  const row = await getActiveConfigEntry(prisma, CHANNELS_KEY);
  const channels = (row?.configValue as Record<string, unknown>) ?? {};
  if (!(channelId in channels)) throw new NotFoundError("CommunicationChannel");
  return maskSecrets(channels[channelId]);
}

export async function updateChannel(
  prisma: PrismaClient,
  channelId: string,
  input: Record<string, unknown>,
  actorId: string,
) {
  if (!channelId.trim()) throw new ValidationError("channelId is required");

  const row = await getActiveConfigEntry(prisma, CHANNELS_KEY);
  const channels = ((row?.configValue as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const merged = mergePreservingSecrets(input, channels[channelId]);
  const next = { ...channels, [channelId]: merged };

  return prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, {
      configKey: CHANNELS_KEY,
      configValue: next as Prisma.InputJsonValue,
      actorId,
      notes: `Channel "${channelId}" updated`,
    });
    return maskSecrets(merged);
  });
}

function guestReplySetting(key: string) {
  const setting = GUEST_REPLY_SETTINGS.find((s) => s.key === key);
  if (!setting) throw new NotFoundError("Guest reply setting");
  return setting;
}

/** One email's reply setting. With no row saved it reads as on, the rule the desk has always run. */
export async function getGuestReplySetting(prisma: PrismaClient, key: string) {
  guestReplySetting(key);
  const row = await getActiveConfigEntry(prisma, key);
  return row?.configValue ?? { required: true };
}

export async function setGuestReplySetting(prisma: PrismaClient, key: string, value: unknown, actorId: string) {
  guestReplySetting(key);
  const required = (value as { required?: unknown } | null)?.required;
  if (typeof required !== "boolean") throw new ValidationError("Say whether the guest's reply must be noted");
  return prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey: key,
      configValue: { required },
      actorId,
      notes: required ? "The guest's reply must be noted" : "The guest's reply is not needed",
    }),
  );
}

export async function getAcknowledgementWindow(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, ACK_WINDOW_KEY);
  return row?.configValue ?? null;
}

export async function setAcknowledgementWindow(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: ACK_WINDOW_KEY, configValue: value, actorId }));
}
