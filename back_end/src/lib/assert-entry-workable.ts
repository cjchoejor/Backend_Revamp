import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "./errors.js";
import { enforceEntryNotSealedForWorkingAction } from "../policies/01-availability/p01-entry-progression-stage-gates.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Refuse a working action on a booking that has ended (2026-10-01).
 *
 * For the call sites that are keyed by something else — a quotation, an invoice — and so do
 * not already have the entry in hand. Where the service has loaded the entry, call
 * `enforceEntryNotSealedForWorkingAction` directly instead of paying for a second read.
 *
 * Why it is needed at all: a lapse leaves the booking's STAGE where it was (only the
 * cancellation routes move it to TERMINAL), so every stage gate still passes on a dead record.
 * The desk cannot catch this — its copy of the booking predates the clock firing — so the
 * refusal has to come from here.
 */
export async function assertEntryWorkable(db: Db, entryId: string): Promise<void> {
  const entry = await db.entry.findUnique({ where: { id: entryId }, select: { status: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
}
