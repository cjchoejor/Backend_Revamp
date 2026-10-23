/**
 * Which guest of a booking is the LEAD (2026-10-23, operator: "add a lead mark") — the adult
 * whose document the Check-in verification vouches for, whose row the returning guest's number
 * is pulled into, and whose name the Check-in step shows.
 *
 * The desk marks one adult row of the guest table (`Entry.leadGuestSubjectKey`). Unmarked, or
 * marked on a row the party no longer has (fewer adults since), the lead is the first adult row,
 * "A0" — which is what the lead always was before the mark existed, so older bookings read the
 * same.
 */

type PartyShape = {
  leadGuestSubjectKey?: string | null;
  adultCount: number | null;
  childAges: number[] | null;
  guestCount: number | null;
};

/** The adult rows of the party, in the guest table's own keys (the same as `derivePartySlots`). */
export function adultSubjectKeys(entry: PartyShape): string[] {
  const adults = Math.max(0, entry.adultCount ?? 0);
  const children = entry.childAges ?? [];
  const n = adults > 0 || children.length > 0 ? adults : Math.max(1, entry.guestCount ?? 1);
  return Array.from({ length: n }, (_, i) => `A${i}`);
}

/** The lead's row key: the marked adult while the party still has that row, else the first. */
export function resolveLeadSubjectKey(entry: PartyShape): string {
  const keys = adultSubjectKeys(entry);
  const marked = entry.leadGuestSubjectKey?.trim();
  if (marked && keys.includes(marked)) return marked;
  return keys[0] ?? "A0";
}

/**
 * Whether a stored document row from an EARLIER booking is that booking's lead's (or a slot-less
 * verification record) — the only rows that speak for the guest on file. A companion's number
 * from an earlier stay is not this guest's ID.
 */
export function isLeadDocumentRow(row: { subjectKey: string | null; entry: PartyShape | null }): boolean {
  if (!row.subjectKey) return true;
  if (!row.entry) return row.subjectKey === "A0";
  return row.subjectKey === resolveLeadSubjectKey(row.entry);
}

/** The select that lets `isLeadDocumentRow` judge a row. */
export const LEAD_ROW_ENTRY_SELECT = {
  select: { leadGuestSubjectKey: true, adultCount: true, childAges: true, guestCount: true },
} as const;
