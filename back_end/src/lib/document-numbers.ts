import type { Prisma } from "@prisma/client";
import { allocateReadableId } from "./readable-id.js";

type Tx = Prisma.TransactionClient;

/**
 * A PAPER KEEPS ITS NUMBER; A CHANGE IS A NEW VERSION (2026-11-07, operator: "lets keep their
 * numbers and add version numbers": QUO-0001 → QUO-0001 v2).
 *
 * A booking's first quotation takes a new number from the counter. Every later one — a change of
 * the table, a renegotiation, a way back and forward again — takes the number of the booking's
 * latest quotation and the next version of it, so the guest keeps one number and sees it revised.
 * Only the record's own id changes (`QUO-20261107-0001-v2`); the paper prints the number and the
 * version. A booking split off another, or a return stay, is a booking of its own and starts its
 * own number. Versions only ever go up, so ordering by version agrees with ordering by time.
 *
 * Runs inside the caller's transaction under a lock on the booking, so two papers made at the same
 * moment cannot take the same version.
 */
export async function nextQuotationNumberTx(tx: Tx, entryId: string, now?: Date) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `quotation-number:${entryId}`);
  const latest = await tx.quotation.findFirst({
    where: { entryId },
    orderBy: [{ createdAt: "desc" }, { versionNumber: "desc" }],
    select: { referenceNumber: true },
  });
  if (!latest?.referenceNumber) {
    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const, now);
    return { id: referenceNumber, referenceNumber, versionNumber: 1 };
  }
  const top = await tx.quotation.aggregate({
    where: { referenceNumber: latest.referenceNumber },
    _max: { versionNumber: true },
  });
  let versionNumber = (top._max.versionNumber ?? 1) + 1;
  // A record already holding this id (data written another way) never blocks a new version.
  while (await tx.quotation.findUnique({ where: { id: `${latest.referenceNumber}-v${versionNumber}` }, select: { id: true } })) {
    versionNumber++;
  }
  return { id: `${latest.referenceNumber}-v${versionNumber}`, referenceNumber: latest.referenceNumber, versionNumber };
}

/**
 * The same for a booking's PROFORMA: a new version keeps the number of the proforma it replaces
 * (`INV-20261107-0004` → `INV-20261107-0004 · v2`, record id `INV-20261107-0004-v2`). A tax
 * invoice, a mid-stay bill and every other invoice keep a number of their own each — a fiscal
 * number is never reused.
 */
export async function nextProformaNumberTx(tx: Tx, entryId: string, folioId: string, now?: Date) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `proforma-number:${entryId}`);
  const latest = await tx.invoice.findFirst({
    where: { folioId, invoiceType: "PROFORMA" },
    orderBy: [{ createdAt: "desc" }, { versionNumber: "desc" }],
    select: { documentNumber: true, id: true, versionNumber: true },
  });
  if (!latest) {
    const number = await allocateReadableId(tx, "INVOICE" as const, now);
    return { id: number, documentNumber: number, versionNumber: 1 };
  }
  // A proforma made before this prints its id; its next version keeps that as the number.
  const number = latest.documentNumber ?? latest.id;
  const top = await tx.invoice.aggregate({
    where: { folioId, invoiceType: "PROFORMA" },
    _max: { versionNumber: true },
  });
  let versionNumber = (top._max.versionNumber ?? latest.versionNumber ?? 1) + 1;
  while (await tx.invoice.findUnique({ where: { id: `${number}-v${versionNumber}` }, select: { id: true } })) {
    versionNumber++;
  }
  return { id: `${number}-v${versionNumber}`, documentNumber: number, versionNumber };
}

/** The number a proforma prints: its own, shared by its versions, else (made before 2026-11-07) its id. */
export function proformaNumberOf(inv: { documentNumber?: string | null; invoiceNumber?: string | null; id: string }): string {
  return inv.documentNumber ?? inv.invoiceNumber ?? inv.id;
}

/**
 * The number as the paper prints it, with its version from the second one on — only where the
 * number is shared by versions (a proforma with a `documentNumber`, a quotation whose number has
 * more than one version). A paper made before 2026-11-07 had a number of its own for every version
 * and prints it bare.
 */
export function printedProformaNumber(inv: { documentNumber?: string | null; invoiceNumber?: string | null; id: string; versionNumber?: number | null }): string {
  return inv.documentNumber ? paperNumber(inv.documentNumber, inv.versionNumber) : proformaNumberOf(inv);
}

export async function printedQuotationNumber(
  db: { quotation: { count: (a: { where: { referenceNumber: string } }) => Promise<number> } },
  q: { referenceNumber: string; versionNumber?: number | null },
): Promise<string> {
  if (!q.versionNumber || q.versionNumber <= 1) return q.referenceNumber;
  const shared = await db.quotation.count({ where: { referenceNumber: q.referenceNumber } });
  return shared > 1 ? paperNumber(q.referenceNumber, q.versionNumber) : q.referenceNumber;
}

/** How a paper's number reads: "QUO-20261107-0001", or "QUO-20261107-0001 · v2" from the second version. */
export function paperNumber(number: string, version?: number | null): string {
  return version != null && version > 1 ? `${number} · v${version}` : number;
}
