import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

/** Atlas Cat 06 group 02 (§5.2.2) — P3 initial custodian resolution. */
export async function resolveInitialCustodianActorId(
  prisma: PrismaClient,
  input: { sourceChannel: string },
): Promise<string> {
  const rules = await requireActiveConfigValue<any[]>(prisma, "ownership.assignmentRules");
  const rule = rules.find((r) => String(r.channel).toUpperCase() === input.sourceChannel.toUpperCase());
  const custodian = rule?.custodianActorId ? String(rule.custodianActorId) : null;
  if (!custodian) throw new MissingConfigurationError("ownership.assignmentRules");
  return custodian;
}
