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


/**
 * S6 check-in gate (2026-11-25, operator: an adult's passport on a child's row and a child's on an
 * adult's row went through Check-in to Stay — "how did the system allow the user to move forward").
 * A date of birth that puts a guest in another price band than their row (`AgeCheck.blocks`) is
 * put right before the guest is checked in: the date fixed, the two rows swapped, or the child's
 * age changed. The FOM (or above) may check in with the rows as they are, saying why — for a party
 * booked wrong that can no longer be changed at Check-in (the guests change at Arrival).
 */
export function enforceGuestAgesFitRowsForCheckIn(input: {
  mismatches: { label: string; message: string }[];
  acceptedNote?: string | null;
  actorLevel?: string | null;
}) {
  if (input.mismatches.length === 0) return;
  const level = input.actorLevel ?? "L1";
  const mayAccept = level === "L2" || level === "L3" || level === "L4";
  if (mayAccept && input.acceptedNote && input.acceptedNote.trim().length > 0) return;
  const rows = input.mismatches.map((m) => m.label).join(", ");
  throw new PolicyGateBlockedError(
    "GUEST_AGE_MISMATCH",
    `A date of birth does not fit its guest's row — ${rows}. Put the date right, swap the two guests' rows, or change the child's age; ` +
      (mayAccept ? "or check in with them as they are and say why." : "or ask the FOM to check in with them as they are."),
    { mismatches: input.mismatches },
  );
}
