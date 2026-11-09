import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

/**
 * Policy 52 prerequisite — the reply windows must exist before send. Policy 7's validity window is the
 * hotel's rule since 2026-11-05 (`quoteValidityWindow`), with no setting to check.
 */
export async function enforceQuotationSendTimeGovernanceConfig(prisma: PrismaClient) {
  await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType").catch(() => {
    throw new MissingConfigurationError("acknowledgement.windowPerType");
  });
}
