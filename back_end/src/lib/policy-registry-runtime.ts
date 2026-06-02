import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * ACIG policy-registry runtime bridge (status-report "Option A").
 *
 * Lets runtime TypeScript policy modules read admin-editable parameters/flags from the
 * `policy_registry` table. Reads are cached in-memory with a short TTL; admin writes call
 * `invalidatePolicyRegistryCache()` so changes take effect promptly without a restart.
 *
 * This bridge is purely additive: a policy decision only changes when an active registry
 * row exists for its `policyId`. Absent a row, callers fall back to their existing behaviour.
 */

type Db = PrismaClient | Prisma.TransactionClient;

type CacheEntry = { definition: Record<string, unknown> | null; cachedAt: number };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

/** Clear cached registry policies. Called by admin write paths after a save/deactivate. */
export function invalidatePolicyRegistryCache(policyId?: string): void {
  if (policyId) cache.delete(policyId);
  else cache.clear();
}

/** Returns the active policy definition for `policyId`, or null when none is active. */
export async function getRegistryPolicy(db: Db, policyId: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const cached = cache.get(policyId);
  if (cached && now - cached.cachedAt < TTL_MS) {
    return cached.definition;
  }
  const row = await db.policyRegistry.findFirst({
    where: { policyId, isActive: true },
    orderBy: { version: "desc" },
  });
  const definition = row ? ((row.policyDefinition as Record<string, unknown>) ?? {}) : null;
  cache.set(policyId, { definition, cachedAt: now });
  return definition;
}

/** Reads a boolean `enabled` flag from an active registry policy, falling back when absent. */
export async function isRegistryPolicyEnabled(db: Db, policyId: string, fallback = false): Promise<boolean> {
  const def = await getRegistryPolicy(db, policyId);
  if (!def) return fallback;
  return typeof def.enabled === "boolean" ? def.enabled : fallback;
}

/** Reads a named parameter from an active registry policy, falling back when absent. */
export async function getRegistryPolicyParam<T>(db: Db, policyId: string, key: string, fallback: T): Promise<T> {
  const def = await getRegistryPolicy(db, policyId);
  if (!def) return fallback;
  const value = def[key];
  return value === undefined ? fallback : (value as T);
}
