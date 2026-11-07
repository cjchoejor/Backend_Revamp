/**
 * A paper's number as the desk shows it (2026-11-07, operator: "keep their numbers and add version
 * numbers"). Every version of a booking's quotation, and of its proforma, shares one number; the
 * version is added from the second one on: "QUO-20261107-0001 · v2". A proforma made before this
 * had a number of its own — its id.
 */
export function quoteNo(q: { referenceNumber?: string | null; id: string; versionNumber?: number | null }): string {
  const n = q.referenceNumber ?? q.id;
  return (q.versionNumber ?? 1) > 1 ? `${n} · v${q.versionNumber}` : n;
}

/** The number every version of a proforma shares — without its version. */
export function proformaBaseNo(i: { documentNumber?: string | null; invoiceNumber?: string | null; id: string }): string {
  return i.documentNumber ?? i.invoiceNumber ?? i.id;
}

/** A bill's number with its version from the second one on, where its versions share the number. */
export function billNo(i: { documentNumber?: string | null; invoiceNumber?: string | null; id: string; versionNumber?: number | null }): string {
  const n = proformaBaseNo(i);
  return i.documentNumber && (i.versionNumber ?? 1) > 1 ? `${n} · v${i.versionNumber}` : n;
}

/** A paper's record id as words: a later version's id "QUO-…-0001-v2" reads "QUO-…-0001 · v2". */
export function paperIdWords(id: string): string {
  return id.replace(/-v(\d+)$/, " · v$1");
}
