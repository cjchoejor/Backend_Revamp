import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Business ID prefixes — PREFIX-YYYYMMDD-#### (#### resets each UTC day).
 *
 * Each entity in this map gets a 2–4 character uppercase prefix. Defaults live here as a
 * compile-time fallback; runtime callers should use `resolveReadableIdPrefix(db, entity)` so
 * admin-edited overrides on `idPrefix.assignments` take effect. The compile-time defaults are
 * also the seed values for that ConfigurationEntry.
 */
export const READABLE_ID_DEFAULT_PREFIXES = {
  // 6 originals
  INQUIRY: "INQ",
  ENTRY: "ENT",
  FOLIO: "FOL",
  QUOTATION: "QUO",
  INVOICE: "INV",
  RESERVATION: "RES",
  // 14 tier-A additions
  HANDOFF: "HND",
  WORK_ORDER: "WO",
  LOST_AND_FOUND: "LF",
  DISPUTE: "DSP",
  NO_SHOW: "NS",
  CREDIT_EXTENSION: "CR",
  ROOM_ASSIGNMENT: "RA",
  KEY_RETURN: "KR",
  ROOM_INSPECTION: "INS",
  NIGHT_AUDIT: "NA",
  COMMISSION_DUE: "CD",
  PAYMENT: "PMT",
  AMENDMENT: "AMD",
  COMMUNICATION: "MSG",
  // Phase B — travel agents, corporate accounts, rate cards
  TRAVEL_AGENT: "TA",
  CORPORATE_ACCOUNT: "CORP",
  RATE_CARD: "RC",
  // Identity — staff users, roles, departments, sessions.
  STAFF_USER: "STF",
  ROLE: "ROL",
  DEPARTMENT: "DPT",
  SESSION: "SES",
} as const;

export type ReadableIdEntity = keyof typeof READABLE_ID_DEFAULT_PREFIXES;

/** All 20 entity keys, in stable display order (originals first, then alphabetical tier-A). */
export const READABLE_ID_ENTITIES: ReadableIdEntity[] = [
  "INQUIRY",
  "ENTRY",
  "FOLIO",
  "QUOTATION",
  "INVOICE",
  "RESERVATION",
  "AMENDMENT",
  "COMMISSION_DUE",
  "COMMUNICATION",
  "CREDIT_EXTENSION",
  "DISPUTE",
  "HANDOFF",
  "KEY_RETURN",
  "LOST_AND_FOUND",
  "NIGHT_AUDIT",
  "NO_SHOW",
  "PAYMENT",
  "ROOM_ASSIGNMENT",
  "ROOM_INSPECTION",
  "WORK_ORDER",
  // Phase B
  "TRAVEL_AGENT",
  "CORPORATE_ACCOUNT",
  "RATE_CARD",
  // Identity
  "STAFF_USER",
  "ROLE",
  "DEPARTMENT",
  "SESSION",
];

/** Back-compat — old name kept so existing imports continue to work. */
export const READABLE_ID_PREFIXES = READABLE_ID_DEFAULT_PREFIXES;

export type ReadableIdPrefix = string;

type IdDb = Prisma.TransactionClient | PrismaClient;

/** UTC calendar date as YYYYMMDD. */
export function readableIdSequenceDate(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function formatReadableId(prefix: string, sequenceDate: string, sequence: number): string {
  return `${prefix}-${sequenceDate}-${String(sequence).padStart(4, "0")}`;
}

/** Validates the on-the-wire shape regardless of which prefix produced it. */
const READABLE_ID_PATTERN = /^[A-Z]{2,4}-\d{8}-\d{4}$/;

export function isReadableBusinessId(id: string): boolean {
  return READABLE_ID_PATTERN.test(id);
}

/** Format rules enforced when an admin edits a prefix. */
export const PREFIX_VALIDATION = {
  minLength: 2,
  maxLength: 4,
  pattern: /^[A-Z]+$/, // uppercase letters only — digits would collide with sequence number
};

export function isValidPrefix(prefix: string): boolean {
  return (
    typeof prefix === "string" &&
    prefix.length >= PREFIX_VALIDATION.minLength &&
    prefix.length <= PREFIX_VALIDATION.maxLength &&
    PREFIX_VALIDATION.pattern.test(prefix)
  );
}

// =============================================================================
// Runtime prefix resolution
// =============================================================================

/**
 * Cache for the admin-editable prefix map. Populated on first lookup, invalidated by
 * `clearReadableIdPrefixCache()` after an admin save. TTL is short so a missed invalidation
 * self-heals within a few seconds.
 */
let prefixCache: { map: Record<string, string>; loadedAt: number } | null = null;
const PREFIX_CACHE_TTL_MS = 5_000;

export function clearReadableIdPrefixCache(): void {
  prefixCache = null;
}

/**
 * Look up the active prefix for an entity. Reads the admin override map at
 * `ConfigurationEntry.configKey = "idPrefix.assignments"` (a flat JSON map of entity → prefix);
 * falls back to the compile-time default if the entry doesn't exist or is missing this entity.
 */
export async function resolveReadableIdPrefix(db: IdDb, entity: ReadableIdEntity): Promise<string> {
  const def = READABLE_ID_DEFAULT_PREFIXES[entity];
  const now = Date.now();
  if (prefixCache && now - prefixCache.loadedAt < PREFIX_CACHE_TTL_MS) {
    return prefixCache.map[entity] ?? def;
  }
  const row = await db.configurationEntry.findFirst({
    where: { configKey: "idPrefix.assignments", effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
    select: { configValue: true },
  });
  const map: Record<string, string> = {};
  if (row && row.configValue && typeof row.configValue === "object" && !Array.isArray(row.configValue)) {
    for (const [k, v] of Object.entries(row.configValue as Record<string, unknown>)) {
      if (typeof v === "string" && isValidPrefix(v)) map[k] = v;
    }
  }
  prefixCache = { map, loadedAt: now };
  return map[entity] ?? def;
}

// =============================================================================
// Allocation
// =============================================================================

/**
 * Atomically allocate the next ID for `entity` on the given UTC day. Resolves the active
 * prefix from `ConfigurationEntry.idPrefix.assignments` (admin-editable), then increments
 * the per-(prefix, day) counter on `ReadableIdSequence`.
 *
 * Safe inside a Prisma transaction (recommended for create flows). The `at` argument lets
 * the backfill migration replay each row's `createdAt` so the sequence numbers match the
 * historical creation order.
 */
export async function allocateReadableId(
  db: IdDb,
  entityOrPrefix: ReadableIdEntity | string,
  at: Date = new Date(),
): Promise<string> {
  const prefix = (entityOrPrefix in READABLE_ID_DEFAULT_PREFIXES)
    ? await resolveReadableIdPrefix(db, entityOrPrefix as ReadableIdEntity)
    : (entityOrPrefix as string);

  const sequenceDate = readableIdSequenceDate(at);

  const row = await db.readableIdSequence.upsert({
    where: { prefix_sequenceDate: { prefix, sequenceDate } },
    create: { prefix, sequenceDate, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  });

  return formatReadableId(prefix, sequenceDate, row.lastValue);
}
