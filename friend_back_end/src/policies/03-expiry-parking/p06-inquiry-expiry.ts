import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 6 — Inquiry Expiry Policy (DEV-SPEC Part 5).
 *
 * Pure evaluator. Callers decide whether to hard-block or soft-surface expiry.
 */
export function enforceInquiryNotExpired(input: { now: Date; expiresAt: Date | null | undefined }) {
  if (!input.expiresAt) return;
  if (input.now.getTime() <= input.expiresAt.getTime()) return;
  throw new PolicyGateBlockedError("INQUIRY_EXPIRED", "Inquiry is expired");
}

