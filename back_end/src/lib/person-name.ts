/**
 * One Name field, split here (2026-11-05, operator: "combine the 2 fields as one as name, and in the
 * backend design it in such a way that, say there 3 words, the first two will go to first name and
 * the last word to last name"; "make it not mandatory that 2 names should be present, sometimes
 * people just have one name"; "we need the option to add title wherever name is asked so that user
 * don't have to write title in the name field").
 *
 * The desk repeats `splitTitle` in new_front_end/src/lib/ds/person.ts. Keep the two in step.
 */

/** The titles the desk offers. A title already on a record stays, whatever it is. */
export const PERSON_TITLES = ["Mr", "Ms", "Mrs", "Dr", "Dasho", "Lyonpo", "Aum"] as const;

const TITLE_WORDS: Record<string, string> = {
  mr: "Mr",
  mrs: "Mrs",
  ms: "Ms",
  miss: "Miss",
  dr: "Dr",
  prof: "Prof",
  dasho: "Dasho",
  lyonpo: "Lyonpo",
  aum: "Aum",
};

/**
 * A title typed into the name, taken out: "Mrs.Saraswati" and "Mrs Saraswati" are Mrs + Saraswati.
 * "Drukpa Wangdi" keeps its name (no break after the letters), and a lone "Aum" stays a name.
 */
export function splitTitle(raw: string | null | undefined): { title: string | null; name: string } {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  const m = v.match(/^(mrs|mr|ms|miss|dr|prof|dasho|lyonpo|aum)(?:\.\s*|\s+)(\S.*)$/i);
  if (!m) return { title: null, name: v };
  return { title: TITLE_WORDS[m[1].toLowerCase()], name: m[2] };
}

/** Three words: the first two are the first name, the last is the last name. One word: first name. */
export function splitPersonName(name: string | null | undefined): { firstName: string; lastName: string } {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: words[0] ?? "", lastName: "" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

/** A name and a title as the desk sends them. A title picked beats one typed into the name. */
export function personFromName(input: { title?: string | null; name?: string | null }) {
  const typed = splitTitle(input.name);
  return { title: input.title?.trim() || typed.title, ...splitPersonName(typed.name) };
}

/** A contact person's name with their title in front, as a single line is kept and printed. */
export function titledName(input: { title?: string | null; name?: string | null }): string {
  return [input.title?.trim(), input.name?.trim()].filter(Boolean).join(" ");
}
