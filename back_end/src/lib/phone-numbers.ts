import { ValidationError } from "./errors.js";

/**
 * Phone numbers, one rule everywhere (2026-11-05, operator: "keep a separate field for country code,
 * and based on that set the phone number field to accept exactly the right amount of digits, say
 * +975 was chosen, so user needs to input exactly 8 numbers — do it both for admin console and the
 * stages").
 *
 * A number is one stored value, always written the same way: the code, a space, the digits —
 * "+975 17882104". The screens show it as two fields. Every comparison in the system works on the
 * digits alone (the last eight, usually), so nothing that reads a number has to change.
 *
 * The desk reads this table from GET /api/lookups/phone-rules and repeats `parsePhone` in
 * new_front_end/src/lib/ds/phone.ts to split a stored number for its two fields. Keep the two in step.
 */

export type DialCode = {
  code: string;
  country: string;
  /** How many digits a number has after the code. The same figure twice: exactly that many. */
  min: number;
  max: number;
};

/** The hotel's usual callers first, then by country. A code not listed is typed in by hand. */
export const DIAL_CODES: readonly DialCode[] = [
  { code: "+975", country: "Bhutan", min: 8, max: 8 },
  { code: "+91", country: "India", min: 10, max: 10 },
  { code: "+977", country: "Nepal", min: 10, max: 10 },
  { code: "+880", country: "Bangladesh", min: 10, max: 10 },
  { code: "+61", country: "Australia", min: 9, max: 9 },
  { code: "+43", country: "Austria", min: 10, max: 11 },
  { code: "+32", country: "Belgium", min: 9, max: 9 },
  { code: "+55", country: "Brazil", min: 10, max: 11 },
  { code: "+86", country: "China", min: 11, max: 11 },
  { code: "+33", country: "France", min: 9, max: 9 },
  { code: "+49", country: "Germany", min: 10, max: 11 },
  { code: "+852", country: "Hong Kong", min: 8, max: 8 },
  { code: "+62", country: "Indonesia", min: 9, max: 12 },
  { code: "+39", country: "Italy", min: 9, max: 10 },
  { code: "+81", country: "Japan", min: 10, max: 10 },
  { code: "+60", country: "Malaysia", min: 9, max: 10 },
  { code: "+960", country: "Maldives", min: 7, max: 7 },
  { code: "+95", country: "Myanmar", min: 8, max: 10 },
  { code: "+31", country: "Netherlands", min: 9, max: 9 },
  { code: "+64", country: "New Zealand", min: 8, max: 10 },
  { code: "+63", country: "Philippines", min: 10, max: 10 },
  { code: "+974", country: "Qatar", min: 8, max: 8 },
  { code: "+7", country: "Russia", min: 10, max: 10 },
  { code: "+966", country: "Saudi Arabia", min: 9, max: 9 },
  { code: "+65", country: "Singapore", min: 8, max: 8 },
  { code: "+27", country: "South Africa", min: 9, max: 9 },
  { code: "+82", country: "South Korea", min: 9, max: 10 },
  { code: "+34", country: "Spain", min: 9, max: 9 },
  { code: "+94", country: "Sri Lanka", min: 9, max: 9 },
  { code: "+41", country: "Switzerland", min: 9, max: 9 },
  { code: "+886", country: "Taiwan", min: 9, max: 9 },
  { code: "+66", country: "Thailand", min: 9, max: 9 },
  { code: "+971", country: "UAE", min: 9, max: 9 },
  { code: "+44", country: "UK", min: 10, max: 10 },
  { code: "+1", country: "USA / Canada", min: 10, max: 10 },
  { code: "+84", country: "Vietnam", min: 9, max: 9 },
];

/** A code the table does not know: any length a real number could have. */
export const ANY_CODE_DIGITS = { min: 4, max: 14 } as const;

const ruleOf = (code: string) => DIAL_CODES.find((c) => c.code === code) ?? null;
const fits = (c: { min: number; max: number }, digits: string) => digits.length >= c.min && digits.length <= c.max;

export type ParsedPhone = {
  code: string;
  number: string;
  /**
   * CLEAR — the number says its own code. GUESSED — no code on it, the pattern gives one (eight
   * digits is Bhutan, ten starting 6–9 is India). UNCLEAR — neither: a person has to look.
   */
  sure: "CLEAR" | "GUESSED" | "UNCLEAR";
  note?: string;
};

/** A number with no code of its own, by its pattern. */
function byPattern(d: string): ParsedPhone | null {
  if (d.length === 8) return { code: "+975", number: d, sure: "GUESSED" };
  if (d.length === 10 && /^[6-9]/.test(d)) return { code: "+91", number: d, sure: "GUESSED" };
  if (d.length === 11 && /^0[6-9]/.test(d)) return { code: "+91", number: d.slice(1), sure: "GUESSED" };
  return null;
}

/** Whatever way a number was written, its code and its digits. Null when there is nothing there. */
export function parsePhone(raw: string | null | undefined): ParsedPhone | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (!digits) return { code: "", number: "", sure: "UNCLEAR", note: "there are no digits in it" };
  const listed = DIAL_CODES.filter((c) => digits.startsWith(c.code.slice(1))).sort((a, b) => b.code.length - a.code.length);

  if (v.startsWith("+")) {
    for (const c of listed) {
      const rest = digits.slice(c.code.length - 1);
      if (fits(c, rest)) return { code: c.code, number: rest, sure: "CLEAR" };
    }
    // "+91 09831160983": the zero dialled inside the country.
    for (const c of listed) {
      const rest = digits.slice(c.code.length - 1);
      if (rest.startsWith("0") && fits(c, rest.slice(1))) return { code: c.code, number: rest.slice(1), sure: "CLEAR" };
    }
    // A code marked off by a space or a dash IS a code, one the table knows or not, so what follows
    // is its number, right or wrong. "+975 17123" is five digits short of nothing: read as a stray
    // plus it was the eight digits 97517123, and was stored as a number nobody gave.
    const marked = v.match(/^\+(\d{1,4})[\s-]+(.+)$/);
    if (marked) {
      const rest = marked[2].replace(/\D/g, "");
      if (!ruleOf(`+${marked[1]}`) && fits(ANY_CODE_DIGITS, rest)) return { code: `+${marked[1]}`, number: rest, sure: "CLEAR" };
      return { code: `+${marked[1]}`, number: rest, sure: "UNCLEAR", note: "too many or too few digits for its code" };
    }
    // "+9302031613": a stray plus on a local number.
    const local = byPattern(digits);
    if (local) return { ...local, note: "had a stray plus" };
    const best = listed[0];
    return best
      ? { code: best.code, number: digits.slice(best.code.length - 1), sure: "UNCLEAR", note: "too many or too few digits for its code" }
      : { code: "", number: digits, sure: "UNCLEAR", note: "the code is not one we know" };
  }

  // "91 9028221748", "975-17399796": a listed code marked off, with no plus.
  const marked = v.match(/^(\d{1,4})[\s-]+(.+)$/);
  if (marked) {
    const c = ruleOf(`+${marked[1]}`);
    const rest = marked[2].replace(/\D/g, "");
    if (c && fits(c, rest)) return { code: c.code, number: rest, sure: "CLEAR" };
  }
  // "97517949304", "919932247554": run together. Only the hotel's three usual codes are read this
  // way — any other could just as well be the start of a local number.
  for (const code of ["+975", "+91", "+977"]) {
    const rest = digits.slice(code.length - 1);
    if (digits.startsWith(code.slice(1)) && fits(ruleOf(code)!, rest)) return { code, number: rest, sure: "CLEAR" };
  }
  // "75 17112747": a Bhutan mobile with a broken code in front. It would pass for ten Indian digits.
  if (marked && marked[1].length <= 3) {
    const rest = marked[2].replace(/\D/g, "");
    if (rest.length === 8 && /^(16|17|77)/.test(rest)) {
      return { code: "+975", number: rest, sure: "UNCLEAR", note: `"${marked[1]}" in front is not a code — this may be +975 ${rest}` };
    }
  }
  return byPattern(digits) ?? { code: "", number: digits, sure: "UNCLEAR", note: "the digits fit no country we know" };
}

/** The stored form: "+975 17882104". */
export function formatPhone(code: string, number: string): string {
  return `${code} ${number}`;
}

/** What is wrong with a code and digits, in words; null when they are fine. */
export function phoneProblem(code: string, number: string): string | null {
  const digits = number.replace(/\D/g, "");
  if (!code.trim()) return "pick the country code";
  if (!/^\+\d{1,4}$/.test(code.trim())) return "the country code is a plus and up to four digits";
  const rule = ruleOf(code.trim());
  const r = rule ?? ANY_CODE_DIGITS;
  if (fits(r, digits)) return null;
  const want = r.min === r.max ? `exactly ${r.min}` : `${r.min} to ${r.max}`;
  return `${rule ? `${rule.code} numbers have` : "a number has"} ${want} digits — this has ${digits.length}`;
}

/**
 * A number the desk or the admin console is saving: the stored form, or refused in words. Empty is
 * null: whether a number is needed at all is the caller's rule, not this one's. `label` names it.
 */
export function cleanPhone(raw: string | null | undefined, label: string): string | null {
  const parsed = parsePhone(raw);
  if (!parsed) return null;
  if (parsed.sure !== "UNCLEAR") return formatPhone(parsed.code, parsed.number);
  throw new ValidationError(`${label}: ${phoneProblem(parsed.code, parsed.number) ?? parsed.note ?? "it does not read as a phone number"}`);
}

/**
 * A number carried from one record to another, or read from an old file: the stored form when it can
 * be read, else as it was. Nothing a person typed is refused here, so an old number never stops a
 * return stay or a split; `cleanPhone` guards what is typed.
 */
export function loosePhone(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const parsed = parsePhone(v);
  return parsed && parsed.sure !== "UNCLEAR" ? formatPhone(parsed.code, parsed.number) : v;
}
