/**
 * IdPrefix admin service — lets L4 actors edit the prefix used by each readable-business-ID
 * entity. Persists in `ConfigurationEntry` under a single key (`idPrefix.assignments`) holding
 * a flat JSON map of entity → prefix. Read by `readable-id.ts` at allocation time (cached for
 * 5s to keep the hot path cheap).
 *
 * All business logic — validation, collision check — lives here per the project convention.
 * The front-end only displays the current state and submits the requested change.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import {
  READABLE_ID_DEFAULT_PREFIXES,
  READABLE_ID_ENTITIES,
  isValidPrefix,
  clearReadableIdPrefixCache,
  type ReadableIdEntity,
} from "../../lib/readable-id.js";

export const ID_PREFIX_CONFIG_KEY = "idPrefix.assignments";

export type IdPrefixAssignmentMap = Record<ReadableIdEntity, string>;

export type IdPrefixEntry = {
  entity: ReadableIdEntity;
  currentPrefix: string;
  defaultPrefix: string;
  /** True when the admin-edited value differs from the compile-time default. */
  isOverridden: boolean;
};

/** Read the active assignment map from ConfigurationEntry, falling back to defaults. */
export async function loadIdPrefixAssignments(prisma: PrismaClient): Promise<IdPrefixAssignmentMap> {
  const row = await getActiveConfigEntry(prisma, ID_PREFIX_CONFIG_KEY);
  const raw = (row?.configValue && typeof row.configValue === "object" && !Array.isArray(row.configValue))
    ? (row.configValue as Record<string, unknown>)
    : {};
  const result = {} as IdPrefixAssignmentMap;
  for (const entity of READABLE_ID_ENTITIES) {
    const candidate = raw[entity];
    result[entity] =
      typeof candidate === "string" && isValidPrefix(candidate)
        ? candidate
        : READABLE_ID_DEFAULT_PREFIXES[entity];
  }
  return result;
}

/** Return assignments shaped for display: current vs default, override flag. */
export async function listIdPrefixAssignments(prisma: PrismaClient): Promise<IdPrefixEntry[]> {
  const map = await loadIdPrefixAssignments(prisma);
  return READABLE_ID_ENTITIES.map((entity) => ({
    entity,
    currentPrefix: map[entity],
    defaultPrefix: READABLE_ID_DEFAULT_PREFIXES[entity],
    isOverridden: map[entity] !== READABLE_ID_DEFAULT_PREFIXES[entity],
  }));
}

/**
 * Validate a proposed full assignment map. Two checks:
 *   1) Each prefix matches PREFIX_VALIDATION (2-4 uppercase letters).
 *   2) No two entities share the same prefix.
 * Throws ValidationError on the first failure with a descriptive message.
 */
function validateAssignments(map: IdPrefixAssignmentMap): void {
  const seen = new Map<string, ReadableIdEntity>();
  for (const entity of READABLE_ID_ENTITIES) {
    const prefix = map[entity];
    if (!isValidPrefix(prefix)) {
      throw new ValidationError(
        `Invalid prefix for ${entity}: "${prefix}". Must be 2-4 uppercase letters.`,
      );
    }
    const owner = seen.get(prefix);
    if (owner) {
      throw new ValidationError(
        `Prefix "${prefix}" is already used by ${owner}. Each entity must have a unique prefix.`,
      );
    }
    seen.set(prefix, entity);
  }
}

/**
 * Update a single entity's prefix. Merges with the current map, validates the merged result
 * (so collisions are caught), and writes a new ConfigurationEntry version. Cache invalidated
 * inline so the change takes effect immediately for the next allocateReadableId() call.
 */
export async function setIdPrefix(
  prisma: PrismaClient,
  entity: ReadableIdEntity,
  newPrefix: string,
  actorId: string,
  notes?: string | null,
): Promise<IdPrefixEntry[]> {
  if (!READABLE_ID_ENTITIES.includes(entity)) {
    throw new ValidationError(`Unknown entity: ${entity}`);
  }
  const normalized = newPrefix.trim().toUpperCase();
  if (!isValidPrefix(normalized)) {
    throw new ValidationError(
      `Invalid prefix "${newPrefix}". Must be 2-4 uppercase letters (A-Z) only.`,
    );
  }

  const current = await loadIdPrefixAssignments(prisma);
  const next: IdPrefixAssignmentMap = { ...current, [entity]: normalized };
  validateAssignments(next);

  await prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey: ID_PREFIX_CONFIG_KEY,
      configValue: next as unknown as Prisma.InputJsonValue,
      actorId,
      notes: notes ?? `Updated ${entity} prefix to ${normalized}`,
    }),
  );

  clearReadableIdPrefixCache();
  return listIdPrefixAssignments(prisma);
}

/** Reset one entity to its compile-time default prefix. */
export async function resetIdPrefix(
  prisma: PrismaClient,
  entity: ReadableIdEntity,
  actorId: string,
): Promise<IdPrefixEntry[]> {
  return setIdPrefix(prisma, entity, READABLE_ID_DEFAULT_PREFIXES[entity], actorId, `Reset ${entity} prefix to default`);
}
