/**
 * Contact-person lists on standing commercial parties (TravelAgent / CorporateAccount).
 *
 * Both carry `coordinators` as a JSON array of `{ name, phone?, email? }` — the agency's or
 * client's people who ring in bookings. The desk reads this at S1 intake to fill
 * `Entry.contactPerson*` (SIG-S1 / W4 pre-arrival requires an on-site contact) rather than the
 * operator retyping a number every call, and may append a new person mid-call.
 *
 * Normalisation and dedupe live here so the two services can't drift apart.
 */

export type CoordinatorContact = { name: string; phone?: string | null; email?: string | null };

/** Digits-only form of a phone, for comparing "+975 17 88 21 04" with "97517882104". */
function phoneKey(phone: string | null | undefined): string {
  return typeof phone === "string" ? phone.replace(/\D/g, "") : "";
}

/**
 * Identity of a contact within one party's list. Phone is the real identifier when present — the
 * same person is often entered with a different spelling of their name. Falls back to the name.
 */
function contactKey(c: CoordinatorContact): string {
  const p = phoneKey(c.phone);
  return p ? `p:${p}` : `n:${c.name.trim().toLowerCase()}`;
}

/**
 * Normalise a coordinators array: each entry must have a non-empty name; phone/email are optional
 * and blank strings collapse to null. Entries that are duplicates of an earlier one (same phone,
 * or same name when neither has a phone) are dropped. Anything that isn't an object is skipped.
 */
export function normalizeCoordinators(v: unknown): CoordinatorContact[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: CoordinatorContact[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const phone = typeof obj.phone === "string" && obj.phone.trim() ? obj.phone.trim() : null;
    const email = typeof obj.email === "string" && obj.email.trim() ? obj.email.trim() : null;
    const contact: CoordinatorContact = { name, phone, email };
    const key = contactKey(contact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contact);
  }
  return out;
}

export type AppendContactResult = {
  /** The full normalised list after the append. */
  coordinators: CoordinatorContact[];
  /** The contact as stored — the pre-existing row when this was already a known person. */
  contact: CoordinatorContact;
  /** False when the contact was already in the list, so the caller can skip the write. */
  added: boolean;
};

/**
 * Append one contact to an existing list, treating a same-phone entry as already present. When the
 * existing row has a blank/placeholder email or the incoming one adds detail the stored row lacks,
 * the missing fields are filled in — but an existing name is never overwritten, since the stored
 * spelling is the one an admin curated.
 */
export function appendContact(existing: unknown, incoming: CoordinatorContact): AppendContactResult {
  const list = normalizeCoordinators(existing);
  const [normalized] = normalizeCoordinators([incoming]);
  if (!normalized) {
    throw new Error("contact requires a non-empty name");
  }

  const key = contactKey(normalized);
  const index = list.findIndex((c) => contactKey(c) === key);
  if (index === -1) {
    return { coordinators: [...list, normalized], contact: normalized, added: true };
  }

  const current = list[index];
  const merged: CoordinatorContact = {
    name: current.name,
    phone: current.phone ?? normalized.phone ?? null,
    email: current.email ?? normalized.email ?? null,
  };
  const next = [...list];
  next[index] = merged;
  return { coordinators: next, contact: merged, added: false };
}
