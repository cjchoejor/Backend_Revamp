import type { PrismaClient } from "@prisma/client";

/**
 * Atlas Cat 08 — W17 VoiceNoteSLAWorker (voice note SLA approach / breach).
 * **Not registered in `workers/runner.ts` yet.**
 */
export async function runVoiceNoteSlaWorker(_prisma: PrismaClient, _input: Record<string, unknown> = {}) {
  return { skipped: true, reason: "NOT_IMPLEMENTED" } as const;
}
