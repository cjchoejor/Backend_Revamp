import type { PrismaClient } from "@prisma/client";

/**
 * Atlas Cat 08 — W19 CorrectionLogAggregationWorker (periodic aggregation).
 * **Not registered in `workers/runner.ts` yet.**
 */
export async function runCorrectionLogAggregationWorker(_prisma: PrismaClient, _input: Record<string, unknown> = {}) {
  return { skipped: true, reason: "NOT_IMPLEMENTED" } as const;
}
