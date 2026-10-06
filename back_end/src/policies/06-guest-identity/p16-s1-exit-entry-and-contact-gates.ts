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

/**
 * SIG-S1 §1.4 item 5 — "primary contact details are captured on the GuestProfile".
 *
 * **Recorded deviation (operator ruling 2026-10-06):** the guest's phone is optional at intake,
 * like the email ("we usually just need it when travel agents come, but we cover that on the
 * top for the travel agent section"). An agency booking reaches its people through the agency's
 * contact, which the intake writes to `Entry.contactPersonPhone`, not onto the traveller's own
 * record. So the gate asks for A contact — the guest's email or phone, or the booking's contact
 * person's phone — rather than one on the GuestProfile itself. A booking nobody can be reached on
 * still cannot leave Inquiry, which is the spec's purpose.
 */
export function enforceGuestProfilePrimaryContactForS1Exit(input: {
  email: string | null | undefined;
  phone: string | null | undefined;
  contactPersonPhone?: string | null | undefined;
}) {
  const hasAnyContact = !!(input.email?.trim?.() || input.phone?.trim?.() || input.contactPersonPhone?.trim?.());
  if (hasAnyContact) return;
  throw new StageGateBlockedError(
    "A way to reach someone is needed before Negotiation — the guest's phone or email, or the phone of whoever is arriving",
    "MISSING_PRIMARY_CONTACT",
  );
}
