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

// --- Discount thresholds (discount.fom.maxPercentage / discount.gm.maxPercentage) ---

export async function getDiscountThresholds(prisma: PrismaClient) {
  return {
    fomMaxPercentage: await readActive(prisma, "discount.fom.maxPercentage"),
    gmMaxPercentage: await readActive(prisma, "discount.gm.maxPercentage"),
  };
}

export async function setDiscountThresholds(
  prisma: PrismaClient,
  input: { fomMaxPercentage: number; gmMaxPercentage: number },
  actorId: string,
) {
  await requiredControlCheck({ surfaceName: "discount_thresholds", proposedChange: input, operationType: "UPDATE", actorId });
  return prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, { configKey: "discount.fom.maxPercentage", configValue: input.fomMaxPercentage, actorId });
    await supersedeConfigurationEntry(tx, { configKey: "discount.gm.maxPercentage", configValue: input.gmMaxPercentage, actorId });
    return { fomMaxPercentage: input.fomMaxPercentage, gmMaxPercentage: input.gmMaxPercentage };
  });
}

// --- FOC configuration ---

export async function getFOCConfiguration(prisma: PrismaClient) {
  return readActive(prisma, "foc.configuration");
}
export async function setFOCConfiguration(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "foc.configuration", value, actorId);
}

// --- Confirmation authority thresholds ---

export async function getConfirmationAuthorityThresholds(prisma: PrismaClient) {
  return readActive(prisma, "confirmation.authorityThresholds");
}
export async function setConfirmationAuthorityThresholds(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "confirmation.authorityThresholds", value, actorId);
}

// --- Overbooking limits ---

export async function getOverbookingLimits(prisma: PrismaClient) {
  return readActive(prisma, "overbooking.maxAllowedRooms");
}
export async function setOverbookingLimits(prisma: PrismaClient, maxAllowedRooms: number, actorId: string) {
  if (!Number.isFinite(maxAllowedRooms) || maxAllowedRooms < 0) {
    throw new ValidationError("overbooking.maxAllowedRooms must be a non-negative integer");
  }
  return setKey(prisma, "overbooking.maxAllowedRooms", maxAllowedRooms, actorId);
}

// --- Credit ceiling thresholds (clientTier + proximity) ---

export async function getCreditCeilingThresholds(prisma: PrismaClient) {
  return {
    clientTierThresholds: await readActive(prisma, "creditCeiling.clientTier.thresholds"),
    proximityThresholds: await readActive(prisma, "creditCeiling.proximityThresholds"),
  };
}

export async function setCreditCeilingThresholds(
  prisma: PrismaClient,
  input: { clientTierThresholds: Prisma.InputJsonValue; proximityThresholds: Prisma.InputJsonValue },
  actorId: string,
) {
  await requiredControlCheck({ surfaceName: "credit_extension_ceiling_thresholds", proposedChange: input.clientTierThresholds, operationType: "UPDATE", actorId });
  return prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, { configKey: "creditCeiling.clientTier.thresholds", configValue: input.clientTierThresholds, actorId });
    await supersedeConfigurationEntry(tx, { configKey: "creditCeiling.proximityThresholds", configValue: input.proximityThresholds, actorId });
    return input;
  });
}

// --- Speculative hold placement thresholds ---

export async function getSpeculativeHoldThresholds(prisma: PrismaClient) {
  return readActive(prisma, "speculativeHold.placementThresholds");
}
export async function setSpeculativeHoldThresholds(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "speculativeHold.placementThresholds", value, actorId);
}

// --- Write-off authority thresholds ---

export async function getWriteOffAuthorityThresholds(prisma: PrismaClient) {
  return readActive(prisma, "writeOff.authority.thresholds");
}
export async function setWriteOffAuthorityThresholds(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "writeOff.authority.thresholds", value, actorId);
}
