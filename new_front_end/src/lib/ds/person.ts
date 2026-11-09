/**
 * A person's name on the desk (2026-11-05): one Name field beside a Title. The backend splits the
 * name for its two columns; `splitTitle` repeats back_end/src/lib/person-name.ts so a line kept as one
 * string ("Mrs Saraswati") can be shown in the two fields. Keep the two in step.
 */
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

export function splitTitle(raw: string | null | undefined): { title: string; name: string } {
  const v = (raw ?? "").trimStart();
  // Nothing after the title yet is fine: "Mr " is a title picked before the name is typed.
  const m = v.match(/^(mrs|mr|ms|miss|dr|prof|dasho|lyonpo|aum)(?:\.\s*|\s+)(.*)$/i);
  if (!m) return { title: "", name: v };
  return { title: TITLE_WORDS[m[1].toLowerCase()], name: m[2] };
}

/**
 * The same line while it is being typed: the name kept exactly as typed, spaces too, and a title with
 * no name yet kept as "Mr " so the next key goes into the name. Saving trims it.
 */
export function joinTitled(title: string | null | undefined, name: string): string {
  return title?.trim() ? `${title.trim()} ${name}` : name;
}

/** A title and a name as one line, as a contact person is kept and printed. */
export function titled(title: string | null | undefined, name: string | null | undefined): string {
  return [title?.trim(), name?.trim()].filter(Boolean).join(" ");
}

/** A stored first and last name as the one Name field shows them. */
export function fullNameOf(firstName: string | null | undefined, lastName: string | null | undefined): string {
  return [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
}
