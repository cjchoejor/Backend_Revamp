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

