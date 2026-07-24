/**
 * Policy 14 — Shadow Inventory Visibility Policy (DEV-SPEC Part 5).
 *
 * A pure evaluator that decides whether a room should be visible to the caller,
 * based on a precomputed flag and the caller's actor level/rules.
 *
 * NOTE: The availability engine is the delegated computation source; this policy exists
 * so services have an explicit policy surface to call/trace.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isRegistryPolicyEnabled } from "../../lib/policy-registry-runtime.js";

export function isShadowInventoryVisible(input: { isShadowInventory: boolean; actorLevel: string; ruleAllows: boolean }) {
  if (!input.isShadowInventory) return true;
  return input.ruleAllows === true;
}

/**
 * Opt-in registry bridge for shadow-inventory visibility. When the admin-owned registry
 * policy `registry.shadowInventory.l4Only` is active and enabled, only L4 may see shadow
 * inventory regardless of the configured visibility rule. Otherwise the configured
 * `ruleAllows` value is returned unchanged (backward compatible).
 *
 * Callers (e.g. the availability engine) may adopt this to make shadow-inventory visibility
 * admin-tunable at runtime via the Policy Registry surface.
 */
export async function resolveShadowInventoryRuleAllows(
  db: PrismaClient | Prisma.TransactionClient,
  actorLevel: string,
  configuredRuleAllows: boolean,
): Promise<boolean> {
  const l4Only = await isRegistryPolicyEnabled(db, "registry.shadowInventory.l4Only", false);
  if (l4Only) return actorLevel === "L4";
  return configuredRuleAllows;
}
