import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 43 — Credit Ceiling Commitment Snapshot Carry Policy (DEV-SPEC Part 5).
 *
 * Pure evaluator: if a credit ceiling existed at commitment, it must be carried into
 * the reservation snapshot / activation context.
 */
export function enforceCreditCeilingSnapshotCarried(input: { hadCreditCeilingAtCommitment: boolean; hasSnapshotCeiling: boolean }) {
  if (!input.hadCreditCeilingAtCommitment) return;
  if (input.hasSnapshotCeiling) return;
  throw new PolicyGateBlockedError("CREDIT_CEILING_SNAPSHOT_MISSING", "Credit ceiling must be carried into the commitment snapshot");
}

