import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 15 — Guest Identity Capture Policy (DEV-SPEC Part 5).
 *
 * Pure gates for whether identity capture is complete enough to proceed.
 */
export function enforceIdentityCaptured(input: { hasIdentityDocumentOnFile: boolean }) {
  if (input.hasIdentityDocumentOnFile) return;
  throw new PolicyGateBlockedError("IDENTITY_NOT_CAPTURED", "Guest identity document must be captured");
}

/**
 * S6 check-in gate (2026-08-11, operator ruling): guest details must be on file for EVERY
 * guest in the party before check-in completes — a typed document number or a stored ID photo
 * counts, and details captured at S5 carry forward. VIP bookings are exempt: the caller skips
 * this gate entirely when the guest profile carries a VIP tier.
 */
export function enforceGuestDetailsCapturedForCheckIn(input: {
  missing: { key: string; label: string }[];
}) {
  if (input.missing.length === 0) return;
  const names = input.missing.map((m) => m.label).join(", ");
  throw new PolicyGateBlockedError(
    "GUEST_DETAILS_INCOMPLETE",
    `Guest details are required before check-in — missing for: ${names}. Record each guest's document number or ID photo on the guest-detail table (Arrival or Check-in step).`,
  );
}

