import { StageGateBlockedError } from "../../lib/errors.js";

type UnavailableRoom = { inventoryId?: string; roomId?: string; unavailabilityReason?: string };

/**
 * Policy 1 — Availability configuration selection (SIG-S1→S2 slice).
 */
export function enforcePreferredAvailabilityConfigurationSelectedForS1Exit(input: { preferred: unknown | null | undefined }) {
  if (input.preferred) return;
  throw new StageGateBlockedError("No preferred AvailabilityConfiguration selected", "NO_PREFERRED_CONFIGURATION");
}

export function enforcePreferredAvailabilityConfigurationNotStaleForS1Exit(input: { isStale: boolean }) {
  if (!input.isStale) return;
  throw new StageGateBlockedError("Preferred configuration is stale", "PREFERRED_CONFIGURATION_STALE");
}

export function enforceDeficientAcknowledgementsWhenRequiredForS1Exit(input: {
  optionSelected: unknown;
  deficientAcknowledgements: unknown;
}) {
  const selected = input.optionSelected as { isDeficient?: boolean } | null | undefined;
  const needsAck = selected && selected.isDeficient === true;
  if (!needsAck) return;
  const da = input.deficientAcknowledgements;
  if (da && Array.isArray(da) && da.length > 0) return;
  if (da && !Array.isArray(da)) return;
  throw new StageGateBlockedError("DEFICIENT acknowledgement required", "DEFICIENT_ACK_REQUIRED");
}

export function enforceSelectedRoomNotMaintenanceOrBlockedForS1Exit(input: {
  selectedRoomId: string | undefined;
  resultSet: { unavailableRooms?: UnavailableRoom[] } | null | undefined;
}) {
  if (typeof input.selectedRoomId !== "string") return;
  const rs = input.resultSet ?? {};
  const unavailable = (rs.unavailableRooms ?? []).find(
    (r) => r.inventoryId === input.selectedRoomId || r.roomId === input.selectedRoomId,
  );
  if (unavailable?.unavailabilityReason === "MAINTENANCE_CONFLICT") {
    throw new StageGateBlockedError("Selected option has maintenance conflict", "MAINTENANCE_CONFLICT");
  }
  if (unavailable?.unavailabilityReason === "BLOCKED") {
    throw new StageGateBlockedError("Selected option is blocked", "ROOM_BLOCKED");
  }
}
