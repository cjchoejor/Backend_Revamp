import { AuthorizationError } from "../../lib/errors.js";

/**
 * Policy 69 — Session Management and PIN Authentication Policy (DEV-SPEC Part 5).
 *
 * Pure gate: invalid PIN must not authenticate.
 *
 * Uses **403** (not 409) so callers behave like standard credential rejection.
 */
export function enforceValidPin(input: { isPinValid: boolean }) {
  if (input.isPinValid) return;
  throw new AuthorizationError("Invalid PIN");
}

