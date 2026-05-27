import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "./errors.js";
import { requireActiveConfigValue } from "./config-store.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Deferred post-checkout inspection window (W9). Prefers `inspection.postCheckout.windowHours`, then legacy `windowDays`. */
export async function resolvePostCheckoutInspectionWindowMs(prisma: PrismaClient): Promise<number> {
  try {
    const hours = Number(await requireActiveConfigValue<number>(prisma, "inspection.postCheckout.windowHours"));
    if (Number.isFinite(hours) && hours > 0) return hours * MS_PER_HOUR;
  } catch {
    /* try legacy days */
  }
  try {
    const days = Number(await requireActiveConfigValue<number>(prisma, "inspection.postCheckout.windowDays"));
    if (Number.isFinite(days) && days >= 1) return days * MS_PER_DAY;
  } catch {
    /* fall through */
  }
  throw new MissingConfigurationError("inspection.postCheckout.windowHours");
}
