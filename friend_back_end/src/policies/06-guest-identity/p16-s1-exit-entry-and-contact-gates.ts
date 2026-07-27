import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 16 — Guest identity / entry completeness (SIG-S1→S2 exit slice).
 */
export function enforceGuestProfileLinkedForS1Exit(input: { guestProfileId: string | null | undefined }) {
  if (input.guestProfileId) return;
  throw new StageGateBlockedError("guestProfileId is required", "MISSING_GUEST_PROFILE");
}

export function enforceUseTypePresentForS1Exit(input: { useType: string | null | undefined }) {
  if (input.useType?.trim()) return;
  throw new StageGateBlockedError("useType is required", "MISSING_USE_TYPE");
}

export function enforceGuestCountPresentForS1Exit(input: { guestCount: number | null | undefined }) {
  if (input.guestCount != null && input.guestCount >= 1) return;
  throw new StageGateBlockedError("guestCount is required", "MISSING_GUEST_COUNT");
}

export function enforceStayDatesPresentForS1Exit(input: {
  checkInDate: Date | null | undefined;
  checkOutDate: Date | null | undefined;
}) {
  if (input.checkInDate && input.checkOutDate) return;
  throw new StageGateBlockedError("checkInDate/checkOutDate are required", "MISSING_STAY_DATES");
}

export function enforceGuestProfilePrimaryContactForS1Exit(input: {
  email: string | null | undefined;
  phone: string | null | undefined;
}) {
  const hasAnyContact = !!(input.email?.trim?.() || input.phone?.trim?.());
  if (hasAnyContact) return;
  throw new StageGateBlockedError("Primary contact details required on GuestProfile", "MISSING_PRIMARY_CONTACT");
}
