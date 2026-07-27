/**
 * ModeConfiguration runtime bridge.
 *
 * ACIG §2.1A.7 seeds 8 predefined modes (NEW_BOOKING, ROOM_CHANGE, RATE_REVISION,
 * DATE_EXTENSION, EARLY_DEPARTURE, BILLING_MODEL_CHANGE, GUEST_COMPOSITION_CHANGE,
 * COMPLAINT_RESOLUTION). The registry rows have `stageRoute`, `autoFulfilmentConditions`,
 * `featureDependencies`. Previously nothing operational consulted them — the modes existed as
 * "dormant configuration". This module wires them up.
 *
 * How the backflow engine uses it:
 *   1. Operator picks (or the caller supplies) a `modeKey` when initiating a backflow.
 *   2. `resolveActiveMode(db, modeKey)` returns the highest-version ACTIVE row with typed fields.
 *   3. The backflow service consults `mode.stageRoute` (informational),
 *      `mode.autoFulfilmentConditions` (per-stage bypass hints), and
 *      `mode.featureDependencies` (list of subsystems the flow needs to be functional).
 *   4. If the mode is inactive or the row is missing, the caller must decide whether to fall
 *      back to a hardcoded route or fail loudly. Backflow services fail loudly — the mode
 *      registry is now load-bearing.
 *
 * Cache: 30-second TTL keyed by modeKey. Admin edits invalidate immediately via
 * `invalidateModeRegistryCache()` which admin services call after writes.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { ModeLifecycleState } from "@prisma/client";
import { MissingConfigurationError } from "./errors.js";

export type ModeStageRoute = string[]; // e.g. ["S1","S2","S3","S4","S5","S6","S7","S8","S9"]
export type ModeAutoFulfilmentCondition = { stage: string; condition: string };

export type ResolvedMode = {
  id: string;
  modeKey: string;
  displayName: string;
  version: number;
  lifecycleState: ModeLifecycleState;
  isActive: boolean;
  isPredefined: boolean;
  stageRoute: ModeStageRoute;
  autoFulfilmentConditions: ModeAutoFulfilmentCondition[];
  featureDependencies: string[];
  effectiveFrom: Date;
};

type CacheEntry = { at: number; value: ResolvedMode | null };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 30_000;

type Db = PrismaClient | Prisma.TransactionClient;

/** Normalise raw JSON columns to typed shapes. Defensive against admin-edited malformed rows. */
function normaliseRow(row: {
  id: string;
  modeKey: string;
  displayName: string;
  version: number;
  lifecycleState: ModeLifecycleState;
  isActive: boolean;
  isPredefined: boolean;
  stageRoute: unknown;
  autoFulfilmentConditions: unknown;
  featureDependencies: unknown;
  effectiveFrom: Date;
}): ResolvedMode {
  const stageRoute = Array.isArray(row.stageRoute) ? (row.stageRoute as string[]).filter((s) => typeof s === "string") : [];
  const cond = Array.isArray(row.autoFulfilmentConditions)
    ? (row.autoFulfilmentConditions as unknown[]).flatMap((c) => {
        if (c && typeof c === "object" && "stage" in c && "condition" in c) {
          const stage = (c as { stage: unknown }).stage;
          const condition = (c as { condition: unknown }).condition;
          if (typeof stage === "string" && typeof condition === "string") return [{ stage, condition }];
        }
        return [];
      })
    : [];
  const deps = Array.isArray(row.featureDependencies)
    ? (row.featureDependencies as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  return {
    id: row.id,
    modeKey: row.modeKey,
    displayName: row.displayName,
    version: row.version,
    lifecycleState: row.lifecycleState,
    isActive: row.isActive,
    isPredefined: row.isPredefined,
    stageRoute,
    autoFulfilmentConditions: cond,
    featureDependencies: deps,
    effectiveFrom: row.effectiveFrom,
  };
}

/**
 * Resolve the highest-version ACTIVE row for a mode. Returns null if none exists. Cached 30s.
 * The DB call always uses the `db` argument so callers in a transaction see uncommitted admin
 * writes; cache is skipped when running inside a transaction.
 */
export async function resolveActiveMode(db: Db, modeKey: string): Promise<ResolvedMode | null> {
  const inTx = (db as unknown as { _engineConfig?: unknown; $transaction?: unknown }).$transaction === undefined;
  if (!inTx) {
    const cached = cache.get(modeKey);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  }
  const row = await db.modeConfiguration.findFirst({
    where: { modeKey, isActive: true, lifecycleState: ModeLifecycleState.ACTIVE },
    orderBy: { version: "desc" },
  });
  const value = row ? normaliseRow(row) : null;
  if (!inTx) cache.set(modeKey, { at: Date.now(), value });
  return value;
}

/**
 * Same as resolveActiveMode but throws MissingConfigurationError if the row is missing / inactive.
 * Used by backflow services where operating without a mode config is a spec violation.
 */
export async function requireActiveMode(db: Db, modeKey: string): Promise<ResolvedMode> {
  const mode = await resolveActiveMode(db, modeKey);
  if (!mode) throw new MissingConfigurationError(`Mode configuration '${modeKey}' is not ACTIVE`);
  return mode;
}

/** Invalidate the cache. Called by mode-admin-service after any write. */
export function invalidateModeRegistryCache(modeKey?: string): void {
  if (modeKey) cache.delete(modeKey);
  else cache.clear();
}

/**
 * Does this mode's `stageRoute` legitimise the requested `from→to` transition? Used as a soft
 * check by the backflow orchestrator so an operator can't invoke, say, RATE_REVISION on a path
 * the mode doesn't declare. `stageRoute` lists the stages a mode passes through in order; the
 * transition is legitimate if BOTH stages appear anywhere in the route (order matters only for
 * NEW_BOOKING; regression modes list stages in whatever order they're visited).
 */
export function isTransitionAllowedByMode(mode: ResolvedMode, from: string, to: string): boolean {
  return mode.stageRoute.includes(from) && mode.stageRoute.includes(to);
}
