/**
 * Policy 14 — Shadow Inventory Visibility Policy (DEV-SPEC Part 5).
 *
 * A pure evaluator that decides whether a room should be visible to the caller,
 * based on a precomputed flag and the caller's actor level/rules.
 *
 * NOTE: The availability engine is the delegated computation source; this policy exists
 * so services have an explicit policy surface to call/trace.
 */
export function isShadowInventoryVisible(input: { isShadowInventory: boolean; actorLevel: string; ruleAllows: boolean }) {
  if (!input.isShadowInventory) return true;
  return input.ruleAllows === true;
}

