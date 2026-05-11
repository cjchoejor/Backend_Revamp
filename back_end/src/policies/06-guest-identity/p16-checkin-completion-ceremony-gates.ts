import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 16 — Guest Identity Verification / check-in ceremony (SIG-S6 slice).
 * Registration confirmation and key issuance are mandatory before S6→S7 completion.
 */
export function enforceRegistrationConfirmedForCheckInCompletion(input: { registrationConfirmed: boolean | undefined }) {
  if (input.registrationConfirmed === true) return;
  throw new StageGateBlockedError("Registration must be confirmed", "REGISTRATION_INCOMPLETE");
}

export function enforceKeyCountIssuedForCheckInCompletion(input: { keyCount: number | undefined }) {
  const k = input.keyCount;
  if (k != null && k >= 1 && Number.isInteger(k)) return;
  throw new StageGateBlockedError("At least one key must be issued (keyCount >= 1)", "KEYS_NOT_ISSUED");
}
