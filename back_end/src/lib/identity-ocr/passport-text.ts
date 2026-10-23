/**
 * A passport read from free OCR text (2026-10-23).
 *
 * The strict MRZ parser (`mrz.ts`) wants two clean 44-character lines. A phone photo of a
 * passport page rarely gives that: the layout engine (Florence-2) reads the strip but adds or
 * drops a character here and there, merges the two `<` of the name separator, reads `<` as
 * `K`. Found on the desk's own photos: `T1204522<5IND9708158M2906173<< <<<…` — the strict
 * parser refuses it, yet every field in it is there and carries its check digit.
 *
 * So this reader works from what survives such a read:
 *   - **Line 2** is found by its own structure wherever it sits in a line: a 3-letter
 *     nationality, the date of birth + its check digit, the sex, the expiry + its check digit.
 *     Both check digits must pass (and both dates be real dates), so a match is not luck. The
 *     passport number + its check digit sit immediately before the nationality; it is taken
 *     only when exactly ten characters stand there and its check digit passes.
 *   - **Line 1** (the names) is matched against the PRINTED page: each name-like word the
 *     page prints is looked for in the strip's first line allowing a character or two of OCR
 *     error; the words found are the guest's names, in the strip's order (surname first). The
 *     printed spelling is used — the page is printed for people and reads cleaner.
 *   - **The printed page** fills what the strip did not give: the date of birth when the page
 *     prints its three dates (birth · issue · expiry), a lone `M` / `F`, a lone 3-letter
 *     nationality, and an Indian-format number (a letter and seven digits).
 *
 * A field proven by a check digit (the number, the date of birth, the expiry) is VERIFIED;
 * everything else is READ — names, sex and nationality have no check digit of their own.
 */
import { cleanMrzLine } from "./mrz.js";
import { normaliseDate } from "./layout-parse.js";
import type { FieldConfidence, IdentityExtraction, IdentitySuggestedFields } from "./types.js";

const WEIGHTS = [7, 3, 1];
function charValue(ch: string): number {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return 0; // `<`
}
/** ICAO 9303 check digit (weights 7-3-1, `<` = 0, A = 10 … Z = 35). */
export function mrzCheckDigit(s: string): number {
  let t = 0;
  for (let i = 0; i < s.length; i++) t += charValue(s[i]) * WEIGHTS[i % 3];
  return t % 10;
}

/** Letters OCR puts where the strip has a digit (only used in digit-only positions). */
const AS_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
/** Digits OCR puts where the strip has a letter (the nationality). */
const AS_LETTER: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" };
const digits = (s: string) => s.replace(/[A-Z]/g, (c) => AS_DIGIT[c] ?? c);
const letters = (s: string) => s.replace(/[0-9]/g, (c) => AS_LETTER[c] ?? c);

function realYYMMDD(v: string): boolean {
  const mm = Number(v.slice(2, 4));
  const dd = Number(v.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

function isoFromYYMMDD(v: string, kind: "birth" | "expiry", now: Date): string {
  const yy = Number(v.slice(0, 2));
  const curYY = now.getUTCFullYear() % 100;
  const year = kind === "birth" ? (yy > curYY ? 1900 + yy : 2000 + yy) : 2000 + yy;
  return `${year}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
}

export type MrzLine2 = {
  line: string;
  nationality: string;
  birth: string;
  sex: string;
  expiry: string;
  /** Set only when its own check digit passed. */
  number: string | null;
  /** The digit just before the nationality — the number's check digit, even when the number
   *  itself came back misread; a printed number that agrees with it is proven. */
  numberCheck: number | null;
};

/** Find the strip's second line in any of the given lines (see the module comment); a reading
 *  whose number also passed its check digit is preferred over one that gives the dates alone. */
export function findMrzLine2(lines: string[]): MrzLine2 | null {
  let first: MrzLine2 | null = null;
  for (const raw of lines) {
    const hit = line2In(raw);
    if (hit?.number) return hit;
    first ??= hit;
  }
  return first;
}

function line2In(raw: string): MrzLine2 | null {
  const s = cleanMrzLine(raw);
  if (s.length < 18) return null;
  for (let i = 0; i + 18 <= s.length; i++) {
    const nat = letters(s.slice(i, i + 3));
    if (!/^[A-Z][A-Z<]{2}$/.test(nat)) continue;
    const dob = digits(s.slice(i + 3, i + 9));
    const dc = digits(s[i + 9]);
    const sex = s[i + 10];
    const exp = digits(s.slice(i + 11, i + 17));
    const ec = digits(s[i + 17]);
    if (!/^\d{6}$/.test(dob) || !/^\d$/.test(dc) || !/^\d{6}$/.test(exp) || !/^\d$/.test(ec)) continue;
    // The sex is read but not trusted to anchor the line (a blurred M comes back R or N): the two
    // check-digited dates already pin it.
    if (!/^[A-Z<]$/.test(sex)) continue;
    if (mrzCheckDigit(dob) !== Number(dc) || mrzCheckDigit(exp) !== Number(ec)) continue;
    if (!realYYMMDD(dob) || !realYYMMDD(exp)) continue;
    let number: string | null = null;
    const prefix = s.slice(0, i);
    if (prefix.length === 10) {
      const n = prefix.slice(0, 9);
      const c = digits(prefix[9]);
      if (/^\d$/.test(c) && mrzCheckDigit(n) === Number(c) && /[0-9]/.test(n)) number = n.replace(/<+$/, "");
    }
    const cd = i > 0 ? digits(s[i - 1]) : "";
    return { line: s, nationality: nat.replace(/<+$/, ""), birth: dob, sex, expiry: exp, number, numberCheck: /^\d$/.test(cd) ? Number(cd) : null };
  }
  return null;
}

/** Candidates for the strip's first line: start with `P`, carry `<` fillers, are not line 2. */
function mrzLine1Candidates(lines: string[], line2: string | null): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const s = cleanMrzLine(raw);
    if (s === line2 || out.includes(s)) continue;
    if (/^P[A-Z<]/.test(s) && s.length >= 12 && s.includes("<")) out.push(s);
  }
  return out;
}

/** Best approximate occurrence of `p` inside `t` (edit distance; start + end of the match). */
function approxFind(p: string, t: string): { dist: number; start: number } {
  const m = p.length;
  const n = t.length;
  // Sellers: free start anywhere in t; also track where each alignment began.
  let prev = new Array<number>(n + 1).fill(0);
  let prevStart = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    const curStart = new Array<number>(n + 1);
    cur[0] = i;
    curStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      if (sub <= del && sub <= ins) {
        cur[j] = sub;
        curStart[j] = prevStart[j - 1];
      } else if (del <= ins) {
        cur[j] = del;
        curStart[j] = prevStart[j];
      } else {
        cur[j] = ins;
        curStart[j] = curStart[j - 1];
      }
    }
    prev = cur;
    prevStart = curStart;
  }
  let best = { dist: Number.POSITIVE_INFINITY, start: -1 };
  for (let j = 0; j <= n; j++) if (prev[j] < best.dist) best = { dist: prev[j], start: prevStart[j] };
  return best;
}

/** Words a passport page prints that are labels or headings, never a guest's name. */
const NOT_A_NAME = new Set([
  "REPUBLIC", "INDIA", "INDIAN", "PASSPORT", "TYPE", "CODE", "COUNTRY", "NATIONALITY", "SURNAME", "SURNAMES", "GIVEN",
  "NAME", "NAMES", "SEX", "DATE", "BIRTH", "PLACE", "ISSUE", "EXPIRY", "AUTHORITY", "SIGNATURE", "HOLDER", "THE", "AND",
  "FILE", "NUMBER", "MALE", "FEMALE", "KINGDOM", "BHUTAN", "NEPAL", "OF", "GOVERNMENT", "SEARCH", "VALID", "UNTIL",
  // Country codes print beside the names and sit inside the strip itself.
  "IND", "BTN", "NPL", "BGD", "LKA", "THA", "CHN", "JPN", "USA", "GBR", "PAK", "MDV", "MMR", "AUS", "CAN", "DEU", "FRA",
]);

function titleCase(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** The guest's names: printed words found in the strip's first line, surname first. */
function namesFromStrip(line1: string, printedLines: string[]): string | null {
  const words = new Map<string, string>();
  // The page prints each name on a line of its own. A line holding a strip character (`<`, or the
  // `(` and `«` OCR reads it as) is the strip itself read again, and its words are not names.
  const nameLines = printedLines.filter((x) => !/[<«(]/.test(x) && x.split(/\s+/).filter(Boolean).length <= 2);
  for (const l of nameLines) {
    for (const w of l.split(/[^A-Za-z]+/)) {
      if (w.length < 3 || w.length > 20) continue;
      const up = w.toUpperCase();
      if (NOT_A_NAME.has(up) || words.has(up)) continue;
      words.set(up, w);
    }
  }
  const text = line1.slice(1); // past the document code
  const found: Array<{ word: string; start: number; dist: number }> = [];
  for (const up of words.keys()) {
    const allowed = up.length <= 3 ? 0 : up.length >= 8 ? 2 : 1;
    const hit = approxFind(up, text);
    if (hit.dist <= allowed) found.push({ word: up, start: hit.start, dist: hit.dist });
  }
  // Two printed spellings landing on the same place in the strip are one name — keep the closer.
  found.sort((a, b) => a.start - b.start || a.dist - b.dist);
  const kept: typeof found = [];
  for (const f of found) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.start - f.start) < Math.min(last.word.length, f.word.length) / 2) {
      if (f.dist < last.dist) kept[kept.length - 1] = f;
      continue;
    }
    kept.push(f);
  }
  if (kept.length < 2) return null; // a surname alone, or a given name alone, is not a name to suggest
  // No surname: the strip opens the names with the separator itself ("P<IND<<DEV<DUTT") — every
  // name is a given name, in the strip's order.
  const sep = text.indexOf("<<");
  if (sep >= 0 && sep <= 5 && kept.every((k) => k.start > sep)) return kept.map((k) => titleCase(k.word)).join(" ");
  const [surname, ...given] = kept.map((k) => titleCase(k.word));
  return [...given, surname].join(" ");
}

/** The printed page's dates, earliest first. */
function printedDates(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const d = normaliseDate(l);
    if (d && /^(19|20)\d\d-\d\d-\d\d$/.test(d)) out.add(d);
  }
  return [...out].sort();
}

/**
 * Read a passport from OCR text. `stripLines` are lines that may hold the strip (any engine);
 * `printedLines` the whole page as the layout engine read it. The page alone (no strip found)
 * is read only when `isPassport` says the document is one — a CID with a lone "M" on it must not
 * come back as a passport. Null when nothing was found.
 */
export function readPassportFromText(
  stripLines: string[],
  printedLines: string[],
  opts: { isPassport?: boolean; now?: Date } = {},
): IdentityExtraction | null {
  const now = opts.now ?? new Date();
  const fields: IdentitySuggestedFields = {};
  const conf: IdentityExtraction["fieldConfidence"] = {};
  const put = (k: keyof IdentitySuggestedFields, v: string | null | undefined, c: FieldConfidence) => {
    if (!v || fields[k]) return;
    fields[k] = v;
    conf[k] = c;
  };
  const all = [...stripLines, ...printedLines];
  const line2 = findMrzLine2(all);
  const line1s = mrzLine1Candidates(all, line2?.line ?? null);
  const line1 = line1s[0] ?? null;
  if (!line2 && !line1 && !opts.isPassport) return null;
  if (line2) {
    put("documentNumber", line2.number, "VERIFIED");
    put("dateOfBirth", isoFromYYMMDD(line2.birth, "birth", now), "VERIFIED");
    put("expiryDate", isoFromYYMMDD(line2.expiry, "expiry", now), "VERIFIED");
    // The sex and the nationality carry no check digit: a misread character there passes unseen.
    if (line2.sex === "M" || line2.sex === "F") put("gender", line2.sex, "READ");
    put("nationality", line2.nationality, "READ");
  }
  // The printed page without the strip: the strip's own garbled words must not pass for names.
  const clean = printedLines.map((l) => l.trim()).filter((l) => l && !looksLikeStrip(l));
  for (const l1 of line1s) {
    const name = namesFromStrip(l1, clean);
    if (name) {
      put("fullName", name, "READ");
      break;
    }
  }
  if (!fields.dateOfBirth) {
    const dates = printedDates(clean);
    // A passport page prints three dates — birth, issue, expiry. With all three, the earliest is the birth.
    if (dates.length === 3) put("dateOfBirth", dates[0], "READ");
  }
  if (!fields.gender) {
    const g = clean.find((l) => /^[MF]$/i.test(l));
    if (g) put("gender", g.toUpperCase(), "READ");
  }
  if (!fields.nationality) {
    const n = clean.find((l) => /^(IND|BTN|NPL|BGD|LKA|THA|CHN|JPN|USA|GBR)$/.test(l));
    if (n) put("nationality", n, "READ");
  }
  if (!fields.documentNumber) {
    // A number printed on the page — an Indian-format one (a letter and seven digits) anywhere on a
    // line, since it prints beside its label as often as on a line of its own. One that agrees with
    // the strip's check digit is proven even when the strip's own copy of it came back misread.
    const printed = printedNumbers(clean);
    const agreed = line2?.numberCheck != null ? printed.find((n) => mrzCheckDigit(n.padEnd(9, "<")) === line2.numberCheck) : undefined;
    if (agreed) put("documentNumber", agreed, "VERIFIED");
    else if (printed[0]) put("documentNumber", printed[0], "READ");
  }
  if (!Object.keys(fields).length) return null;
  fields.documentType = "PASSPORT";
  conf.documentType = line2 ? "VERIFIED" : "READ";
  return {
    fields,
    fieldConfidence: conf,
    raw: { mrzLines: [line1, line2?.line].filter((x): x is string => !!x), source: `PASSPORT TEXT${line2 ? " · strip" : ""}${line1 ? " · names" : ""}` },
    empty: false,
  };
}

/** Passport numbers printed on the page (a letter and seven digits), in reading order. */
export function printedNumbers(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|[^A-Z0-9])([A-Z][0-9]{7})(?![A-Z0-9])/g)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** True when a line looks like part of the strip (worth a closer read). */
export function looksLikeStrip(text: string): boolean {
  // The strip is Latin capitals, digits and fillers — a line with Devanagari (the passport's
  // bilingual labels) or mostly lowercase letters is the page, however many brackets it holds
  // (found: "RAJEVEV (ज) (प) (Cov) (Namens)" passed for the strip and the real one was missed).
  if (/[\u0900-\u097F]/.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length && (text.replace(/[^a-z]/g, "").length / letters.length) > 0.4) return false;
  const s = cleanMrzLine(text);
  if (s.length < 15) return false;
  // The filler and what OCR reads it as — not `/`, which printed labels use ("BUXAR/BIHAR").
  const fillers = text.match(/[<«(\[{]/g)?.length ?? 0;
  return fillers >= 1 || findMrzLine2([s]) !== null || (s.length >= 28 && /\d{6}/.test(s));
}
