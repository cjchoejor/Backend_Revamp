import type { Prisma, PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "./errors.js";

export type ConfigReadOptions = {
  now?: Date;
};

export async function getActiveConfigEntry(
  prisma: PrismaClient,
  configKey: string,
  options?: ConfigReadOptions,
) {
  const now = options?.now ?? new Date();
  return prisma.configurationEntry.findFirst({
    where: {
      configKey,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

export async function requireActiveConfigValue<T = Prisma.JsonValue>(
  prisma: PrismaClient,
  configKey: string,
  options?: ConfigReadOptions,
): Promise<T> {
  const row = await getActiveConfigEntry(prisma, configKey, options);
  if (!row) throw new MissingConfigurationError(configKey);
  return row.configValue as T;
}

