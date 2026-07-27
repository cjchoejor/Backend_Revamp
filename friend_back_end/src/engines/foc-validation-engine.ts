import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

export type FocValidationInput = {
  entryId: string;
  roomsRequested: number;
  focRoomsRequested: number;
  now?: Date;
};

export type FocValidationResult = {
  isValid: boolean;
  requiresGmApproval: boolean;
  reasons: string[];
  entitlementAllowedFocRooms: number;
};

export async function validateFoc(prisma: PrismaClient, input: FocValidationInput): Promise<FocValidationResult> {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  const roomsRequested = Number(input.roomsRequested);
  const focRoomsRequested = Number(input.focRoomsRequested);
  if (!Number.isFinite(roomsRequested) || roomsRequested < 1) throw new ValidationError("roomsRequested must be >= 1");
  if (!Number.isFinite(focRoomsRequested) || focRoomsRequested < 1) throw new ValidationError("focRoomsRequested must be >= 1");
  if (focRoomsRequested > roomsRequested) throw new ValidationError("focRoomsRequested cannot exceed roomsRequested");

  const cfg = await requireActiveConfigValue<any>(prisma, "foc.configuration", { now: input.now }).catch(() => {
    throw new MissingConfigurationError("foc.configuration");
  });

  const enabled = cfg?.enabled === true;
  if (!enabled) {
    return { isValid: false, requiresGmApproval: true, reasons: ["FOC_DISABLED"], entitlementAllowedFocRooms: 0 };
  }

  // Minimal entitlement model (config-driven) to satisfy SIG-S3 acceptance tests:
  // entitlement: allow 1 FOC per N rooms.
  const perRooms = Number(cfg?.entitlement?.perRooms ?? 10);
  const allowed = Number.isFinite(perRooms) && perRooms > 0 ? Math.floor(roomsRequested / perRooms) : 0;
  const isValid = focRoomsRequested <= allowed;

  return {
    isValid,
    requiresGmApproval: true,
    reasons: isValid ? [] : ["FOC_ENTITLEMENT_EXCEEDED"],
    entitlementAllowedFocRooms: allowed,
  };
}

