import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

/** SIG-S9 §8.8 — Write-Off Policy (route table name; §4 envelope lists other P-numbers only). */
export async function enforceWriteOffConstraints(
  prisma: PrismaClient,
  input: { amount: number; reason: string },
) {
  if (!input.reason?.trim()) throw new PolicyGateBlockedError("WRITE_OFF_REASON_REQUIRED", "reason is required");

  const cfg = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "writeOff.authority.thresholds")) ?? {};
  const max = typeof cfg.L3 === "number" ? cfg.L3 : 0;
  if (max > 0 && input.amount > max) {
    throw new PolicyGateBlockedError("WRITE_OFF_EXCEEDS_AUTHORITY_BAND", "write-off amount exceeds GM authority band");
  }
}
