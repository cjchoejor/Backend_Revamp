import type { PrismaClient } from "@prisma/client";

/**
 * Atlas Cat 08 — W13 RelocationExternalHandshakeWorker (OTA_CONFLICT open loop).
 * DEV-SPEC / SIG: external relocation handshake when OTA conflict window expires.
 * **Not registered in `workers/runner.ts` yet** — add pg-boss job type + emitter before enabling.
 */
export async function runRelocationExternalHandshakeWorker(_prisma: PrismaClient, _input: Record<string, unknown> = {}) {
  return { skipped: true, reason: "NOT_IMPLEMENTED" } as const;
}
