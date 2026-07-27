import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

/**
 * SIG-S2 Policy 7 (validity window) + Policy 52 prerequisite — configuration must exist before send.
 */
export async function enforceQuotationSendTimeGovernanceConfig(prisma: PrismaClient) {
  await requireActiveConfigValue<number>(prisma, "expiry.s2.quotationValidityDays").catch(() => {
    throw new MissingConfigurationError("expiry.s2.quotationValidityDays");
  });
  await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType").catch(() => {
    throw new MissingConfigurationError("acknowledgement.windowPerType");
  });
}
