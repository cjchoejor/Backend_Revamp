import type { Prisma, PrismaClient } from "@prisma/client";

/** Business ID prefixes — PREFIX-YYYYMMDD-#### (#### resets each UTC day). */
export const READABLE_ID_PREFIXES = {
  INQUIRY: "INQ",
  ENTRY: "ENT",
  FOLIO: "FOL",
  QUOTATION: "QUO",
  INVOICE: "INV",
  RESERVATION: "RES",
} as const;

export type ReadableIdPrefix = (typeof READABLE_ID_PREFIXES)[keyof typeof READABLE_ID_PREFIXES];

type IdDb = Prisma.TransactionClient | PrismaClient;

/** UTC calendar date as YYYYMMDD. */
export function readableIdSequenceDate(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function formatReadableId(prefix: ReadableIdPrefix, sequenceDate: string, sequence: number): string {
  return `${prefix}-${sequenceDate}-${String(sequence).padStart(4, "0")}`;
}

const READABLE_ID_PATTERN = /^[A-Z]{2,4}-\d{8}-\d{4}$/;

export function isReadableBusinessId(id: string): boolean {
  return READABLE_ID_PATTERN.test(id);
}

/**
 * Atomically allocate the next ID for `prefix` on the given UTC day.
 * Safe inside a Prisma transaction (recommended for create flows).
 */
export async function allocateReadableId(
  db: IdDb,
  prefix: ReadableIdPrefix,
  at: Date = new Date(),
): Promise<string> {
  const sequenceDate = readableIdSequenceDate(at);

  const row = await db.readableIdSequence.upsert({
    where: {
      prefix_sequenceDate: { prefix, sequenceDate },
    },
    create: {
      prefix,
      sequenceDate,
      lastValue: 1,
    },
    update: {
      lastValue: { increment: 1 },
    },
  });

  return formatReadableId(prefix, sequenceDate, row.lastValue);
}
