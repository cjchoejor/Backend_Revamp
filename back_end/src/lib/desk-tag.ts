/**
 * The desk tag (2026-11-25, operator: "when there are people coming with the same name, the front desk
 * keeps side notes like BOLD/MOA — their company name or some sort — to remember it; it hinders the
 * name field, the system takes bold/moa as a last name, and the mails may use it").
 *
 * A short note on the ENQUIRY (so every stay of a trip shares it) that tells this booking apart from
 * others of the same name. The desk's own: shown greyed beside the name, searched in the Bookings list,
 * never printed on a paper or in an email. One line, at most 40 characters; empty is none.
 */
import { ValidationError } from "./errors.js";

export const DESK_TAG_MAX = 40;

/** Trimmed, spaces folded, at most 40 characters; empty → null. Refuses a longer one in words. */
export function cleanDeskTag(raw: string | null | undefined): string | null {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length > DESK_TAG_MAX) {
    throw new ValidationError(`A tag is a short note — at most ${DESK_TAG_MAX} characters (this one has ${t.length})`);
  }
  return t;
}

/**
 * Does a word typed into a name look like a desk note rather than a name? A word with a slash
 * ("BOLD/MOA", "OTA/Expedia") or in brackets ("(OTA/Expedia", "(MOA)"). Used to offer moving it to the
 * tag; never to change a name by itself.
 */
export function looksLikeDeskNote(word: string): boolean {
  const w = word.trim();
  return /\//.test(w) || /^[([]/.test(w) || /[)\]]$/.test(w);
}
