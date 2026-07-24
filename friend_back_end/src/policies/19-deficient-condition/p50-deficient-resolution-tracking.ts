import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 50 — DEFICIENT Resolution Tracking Policy (DEV-SPEC Part 5).
 *
 * Pure guard: when a deficient condition is marked resolved, the resolver and timestamp must exist.
 */
export function enforceDeficientResolutionEvidence(input: { nextStatus: string; resolvedAt?: Date | null; resolvedBy?: string | null }) {
  if (input.nextStatus !== "RESOLVED") return;
  if (input.resolvedAt && input.resolvedBy?.trim()) return;
  throw new PolicyGateBlockedError("DEFICIENT_RESOLUTION_EVIDENCE_REQUIRED", "resolvedAt and resolvedBy are required when resolving a deficient condition");
}

