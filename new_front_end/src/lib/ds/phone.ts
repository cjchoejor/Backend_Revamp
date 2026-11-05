/**
 * Phone numbers on the desk (2026-11-05). The table is the backend's (GET /api/lookups/phone-rules);
 * `parsePhone` repeats back_end/src/lib/phone-numbers.ts so a stored number can be split into its two
 * fields as the desk draws them. Keep the two in step. The server's check on saving is the rule.
 */
export type DialCode = { code: string; country: string; min: number; max: number };
export type PhoneRules = { codes: DialCode[]; anyCode: { min: number; max: number }; titles: string[] };

/** Until the backend answers: the two codes most calls use, and no title lost. */
export const START_RULES: PhoneRules = {
  codes: [
    { code: "+975", country: "Bhutan", min: 8, max: 8 },
    { code: "+91", country: "India", min: 10, max: 10 },
  ],
  anyCode: { min: 4, max: 14 },
  titles: ["Mr", "Ms", "Mrs", "Dr", "Dasho", "Lyonpo", "Aum"],
};

export type ParsedPhone = { code: string; number: string; sure: "CLEAR" | "GUESSED" | "UNCLEAR"; note?: string };

const fits = (c: { min: number; max: number }, d: string) => d.length >= c.min && d.length <= c.max;

function byPattern(d: string): ParsedPhone | null {
  if (d.length === 8) return { code: "+975", number: d, sure: "GUESSED" };
  if (d.length === 10 && /^[6-9]/.test(d)) return { code: "+91", number: d, sure: "GUESSED" };
  if (d.length === 11 && /^0[6-9]/.test(d)) return { code: "+91", number: d.slice(1), sure: "GUESSED" };
  return null;
}

export function parsePhone(raw: string | null | undefined, rules: PhoneRules): ParsedPhone | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (!digits) return { code: "", number: "", sure: "UNCLEAR", note: "there are no digits in it" };
  const ruleOf = (code: string) => rules.codes.find((c) => c.code === code) ?? null;
  const listed = rules.codes.filter((c) => digits.startsWith(c.code.slice(1))).sort((a, b) => b.code.length - a.code.length);

  if (v.startsWith("+")) {
    for (const c of listed) {
      const rest = digits.slice(c.code.length - 1);
      if (fits(c, rest)) return { code: c.code, number: rest, sure: "CLEAR" };
    }
    for (const c of listed) {
      const rest = digits.slice(c.code.length - 1);
      if (rest.startsWith("0") && fits(c, rest.slice(1))) return { code: c.code, number: rest.slice(1), sure: "CLEAR" };
    }
    // A code marked off by a space or a dash IS a code, so what follows is its number, right or wrong.
    const marked = v.match(/^\+(\d{1,4})[\s-]+(.+)$/);
    if (marked) {
      const rest = marked[2].replace(/\D/g, "");
      if (!ruleOf(`+${marked[1]}`) && fits(rules.anyCode, rest)) return { code: `+${marked[1]}`, number: rest, sure: "CLEAR" };
      return { code: `+${marked[1]}`, number: rest, sure: "UNCLEAR" };
    }
    const local = byPattern(digits);
    if (local) return local;
    const best = listed[0];
    return best ? { code: best.code, number: digits.slice(best.code.length - 1), sure: "UNCLEAR" } : { code: "", number: digits, sure: "UNCLEAR" };
  }

  const marked = v.match(/^(\d{1,4})[\s-]+(.+)$/);
  if (marked) {
    const c = ruleOf(`+${marked[1]}`);
    const rest = marked[2].replace(/\D/g, "");
    if (c && fits(c, rest)) return { code: c.code, number: rest, sure: "CLEAR" };
  }
  for (const code of ["+975", "+91", "+977"]) {
    const rule = ruleOf(code);
    const rest = digits.slice(code.length - 1);
    if (rule && digits.startsWith(code.slice(1)) && fits(rule, rest)) return { code, number: rest, sure: "CLEAR" };
  }
  if (marked && marked[1].length <= 3) {
    const rest = marked[2].replace(/\D/g, "");
    if (rest.length === 8 && /^(16|17|77)/.test(rest)) return { code: "+975", number: rest, sure: "UNCLEAR" };
  }
  return byPattern(digits) ?? { code: "", number: digits, sure: "UNCLEAR" };
}

/** The stored form, "+975 17882104". No digits, no number. */
export function formatPhone(code: string, number: string): string {
  if (!number) return "";
  return code ? `${code} ${number}` : number;
}

/** What the digits must be for a code, in words: "8", "10 to 11". */
export function digitsWanted(rules: PhoneRules, code: string): { min: number; max: number; words: string } {
  const r = rules.codes.find((c) => c.code === code) ?? rules.anyCode;
  return { min: r.min, max: r.max, words: r.min === r.max ? `${r.min}` : `${r.min} to ${r.max}` };
}

/** What is wrong with a code and digits, in words; null when they are fine. Mirrors the server's. */
export function phoneProblem(rules: PhoneRules, code: string, number: string): string | null {
  if (!code.trim()) return "pick the country code";
  if (!/^\+\d{1,4}$/.test(code.trim())) return "the country code is a plus and up to four digits";
  const want = digitsWanted(rules, code.trim());
  if (number.length >= want.min && number.length <= want.max) return null;
  const listed = rules.codes.some((c) => c.code === code.trim());
  const exact = want.min === want.max ? `exactly ${want.words}` : want.words;
  return `${listed ? `${code.trim()} numbers have` : "a number has"} ${exact} digits — this has ${number.length}`;
}

/** The same for a whole stored value: what stops it being saved, or null (an empty one is fine). */
export function problemOfPhone(rules: PhoneRules, value: string | null | undefined): string | null {
  // A whole number still being typed in the number box, its code first.
  if (/\s\+/.test(value ?? "")) return "finish the number";
  const p = parsePhone(value, rules);
  if (!p || p.sure !== "UNCLEAR") return null;
  return phoneProblem(rules, p.code, p.number) ?? "it does not read as a phone number";
}

/** The digits after the code — what a search for "this number" should look for. */
export function nationalDigits(rules: PhoneRules, value: string | null | undefined): string {
  return parsePhone(value, rules)?.number ?? "";
}
