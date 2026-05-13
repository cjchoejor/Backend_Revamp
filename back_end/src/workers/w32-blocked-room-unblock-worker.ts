import type { PrismaClient } from "@prisma/client";

/**
 * Atlas Cat 08 — W32 BlockedRoomUnblockWorker (unblock date passage).
 * **Distinct from** `w32-fom-override-frequency-worker.ts`, which is a historical wrapper around the W33 FOM implementation.
 * **Not registered in `workers/runner.ts` yet.**
 */
export async function runBlockedRoomUnblockWorker(_prisma: PrismaClient, _input: Record<string, unknown> = {}) {
  return { skipped: true, reason: "NOT_IMPLEMENTED" } as const;
}
