/** Human labels for inventory claim (Model 1) and housekeeping physical state (Model 2). */

export const CLAIM_STATE_LABELS: Record<string, string> = {
  FREE: "Vacant",
  SPECULATIVELY_HELD: "Speculative hold",
  COMMITTED_HELD: "Committed hold",
  CONFIRMED: "Confirmed",
  OCCUPIED: "Occupied",
  DEPARTED_DIRTY: "Departed (dirty)",
  DEPARTED_CLEAN: "Departed (clean)",
};

export const PHYSICAL_STATE_LABELS: Record<string, string> = {
  AVAILABLE_CLEAN: "Clean",
  AVAILABLE_INSPECTED: "Inspected",
  DIRTY: "Dirty",
  UNDER_MAINTENANCE: "Under maintenance",
};

export const UNAVAILABILITY_REASON_LABELS: Record<string, string> = {
  CLAIMED: "Claimed / in use",
  BLOCKED: "Blocked",
  MAINTENANCE_CONFLICT: "Maintenance conflict",
  PHYSICAL_NOT_READY: "Not bookable",
};

export function formatClaimState(state?: string | null): string {
  if (!state) return "—";
  return CLAIM_STATE_LABELS[state] ?? state.replace(/_/g, " ").toLowerCase();
}

export function formatPhysicalState(state?: string | null): string {
  if (!state) return "—";
  return PHYSICAL_STATE_LABELS[state] ?? state.replace(/_/g, " ").toLowerCase();
}

export function formatUnavailabilityReason(reason?: string | null): string {
  if (!reason) return "Unavailable";
  return UNAVAILABILITY_REASON_LABELS[reason] ?? reason.replace(/_/g, " ").toLowerCase();
}

/** Short line for S5/S6 room picker options. */
export function formatRoomPickerLabel(input: {
  roomNumber: string;
  currentClaimState?: string | null;
  physicalState?: string | null;
  isBlocked?: boolean;
}): string {
  const parts = [`Room ${input.roomNumber}`];
  if (input.isBlocked) {
    parts.push("Blocked");
  } else if (input.currentClaimState) {
    parts.push(formatClaimState(input.currentClaimState));
  }
  if (input.physicalState) {
    parts.push(formatPhysicalState(input.physicalState));
  }
  return parts.join(" · ");
}

/** Detail line under an unavailable room row at S1. */
export function describeUnavailableRoom(input: {
  unavailabilityReason?: string | null;
  claimState?: string | null;
  blockedReason?: string | null;
}): string {
  const reason = input.unavailabilityReason;
  if (reason === "CLAIMED" && input.claimState) {
    return `${formatUnavailabilityReason(reason)} — ${formatClaimState(input.claimState)}`;
  }
  if (reason === "PHYSICAL_NOT_READY" && input.claimState) {
    return `${formatUnavailabilityReason(reason)} — ${formatClaimState(input.claimState)}`;
  }
  if (reason === "BLOCKED" && input.blockedReason?.trim()) {
    return `${formatUnavailabilityReason(reason)} — ${input.blockedReason.trim()}`;
  }
  return formatUnavailabilityReason(reason);
}
