import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 51 — DEFICIENT / inspection review (SIG-S9 closure slice).
 */
export function enforceInspectionResolvedForS9Closure(input: {
  latestInspection: { isDeferred: boolean } | null | undefined;
  hasNonDeferredCompletedInspection: boolean;
  hasPostCheckoutInspectionWindowExpiredTrace: boolean;
}) {
  if (!input.latestInspection) {
    throw new StageGateBlockedError("Missing room inspection record", "INSPECTION_MISSING");
  }
  if (!input.latestInspection.isDeferred) return;
  if (input.hasNonDeferredCompletedInspection) return;
  if (input.hasPostCheckoutInspectionWindowExpiredTrace) return;
  throw new StageGateBlockedError("Deferred inspection window not resolved", "INSPECTION_DEFERRED_UNRESOLVED");
}
