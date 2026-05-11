import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — availability configuration context for S2 quotation creation (sealed preferred + room type).
 */
export function enforceEntryAtS2ForQuotationCreation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S2) return;
  throw new StageGateBlockedError("Entry must be at S2 to create quotation", "NOT_AT_S2");
}

export function enforceSealedPreferredAvailabilityConfigurationForS2Quotation(input: {
  preferred: { sealedAt: Date | null; optionSelected: unknown } | null | undefined;
}) {
  if (input.preferred?.sealedAt != null && input.preferred.optionSelected != null) return;
  throw new StageGateBlockedError("Sealed preferred AvailabilityConfiguration required", "NO_PREFERRED_CONFIGURATION");
}

export function enforceRoomTypeResolvedForS2Quotation(input: { roomTypeId: string | null | undefined }) {
  if (input.roomTypeId && typeof input.roomTypeId === "string") return;
  throw new StageGateBlockedError("Preferred configuration missing roomTypeId", "MISSING_ROOM_TYPE");
}
