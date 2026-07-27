import type { Prisma, PrismaClient } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";
import { isRegistryPolicyEnabled } from "../../lib/policy-registry-runtime.js";

/**
 * Policy 12 — Duplicate Detection (SIG-S1 exit).
 * OPEN duplicate flags block S1→S2 (same blockingCondition as S2 path; S1 uses stage gate envelope).
 *
 * Admin override: `registry.duplicateInquiry.blockS1Exit` — when present and `enabled: false`,
 * the guard is bypassed. Default behaviour (no row or `enabled: true`) is unchanged.
 */
export async function enforceNoOpenDuplicateFlagsForS1Exit(
  db: PrismaClient | Prisma.TransactionClient,
  input: { duplicateFlags: Array<{ status?: string | null }> | null | undefined },
) {
  const enabled = await isRegistryPolicyEnabled(db, "registry.duplicateInquiry.blockS1Exit", true);
  if (!enabled) return;
  const flags = input.duplicateFlags ?? [];
  const hasOpen = flags.some((f) => String(f.status ?? "") === "OPEN");
  if (!hasOpen) return;
  throw new StageGateBlockedError("Unresolved duplicate flag blocks S1 exit", "DUPLICATE_UNRESOLVED");
}
