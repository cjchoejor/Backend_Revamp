/**
 * Whether a contact's email reads as one — the desk's copy of `cleanContactEmail` in
 * back_end/src/lib/admin/contact-list.ts (keep the two in step). The server refuses such an email on
 * every save; this says why before the press.
 *
 * Found 2026-11-25 on the hotel's KNG Reservation: a contact saved with "17551410" in the email box
 * stopped every new inquiry through that agency, with nothing on screen saying why.
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Null when the email is empty or reads as one; else what is wrong, in words. */
export function contactEmailProblem(raw: string | null | undefined): string | null {
  const email = (raw ?? "").trim();
  if (!email || EMAIL_SHAPE.test(email)) return null;
  return /^[+\d][\d\s()-]{5,}$/.test(email)
    ? `"${email}" is a phone number, not an email — put it under Phone and leave Email empty`
    : `"${email}" does not read as an email — it needs an @ and a name after it, like name@agency.com`;
}

/** The first contact of a list whose email does not read as one, said with whose it is. */
export function firstContactEmailProblem(list: ReadonlyArray<{ name?: string | null; email?: string | null }> | null | undefined): string | null {
  for (const c of list ?? []) {
    const p = contactEmailProblem(c.email);
    if (p) return `${(c.name ?? "").trim() || "A contact"}'s email ${p}`;
  }
  return null;
}
