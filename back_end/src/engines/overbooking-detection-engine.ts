import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

export type OverbookingResult = {
  overbookingDetected: boolean;
  triggerType: "DELIBERATE" | "OTA_CONFLICT";
  reason: string;
};

export async function detectOverbooking(prisma: PrismaClient, input: { entryId: string; otaSource: boolean }) : Promise<OverbookingResult> {
  const maxAllowed = await requireActiveConfigValue<number>(prisma, "overbooking.maxAllowedRooms").catch(() => {
    throw new MissingConfigurationError("overbooking.maxAllowedRooms");
  });
  const max = Number(maxAllowed ?? 0);
  if (!Number.isFinite(max) || max < 0) {
    return { overbookingDetected: false, triggerType: "DELIBERATE", reason: "CONFIG_INVALID_TREAT_AS_NO_OVERBOOKING" };
  }

  // Minimal slice: treat each active reservation as 1 room; compare count against limit.
  const confirmedCount = await prisma.reservation.count();
  const overbookingDetected = confirmedCount > max && max > 0;
  const triggerType = input.otaSource ? "OTA_CONFLICT" : "DELIBERATE";
  return { overbookingDetected, triggerType, reason: overbookingDetected ? `confirmedCount=${confirmedCount} exceeds maxAllowed=${max}` : "OK" };
}

