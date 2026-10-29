/**
 * Passport MRZ → suggested fields (2026-08-18).
 *
 * The MRZ (the two OCR-B lines at the foot of every passport, TD3; three lines on TD1 ID
 * cards) is machine-readable BY DESIGN and carries check digits — a field whose check digit
 * passes is proven by the document, which is why MRZ fields can be marked VERIFIED while
 * everything else the OCR pipeline produces stays READ. Parsing is delegated to the `mrz`
 * package (ICAO 9303 formats + per-field check-digit validation); this module cleans the
 * lines OCR hands over, maps the result onto the guest-detail shape, and resolves the
 * two-digit years.
 */
import { parse as parseMrz } from "mrz";
import type { FieldConfidence, IdentityExtraction, IdentitySuggestedFields } from "./types.js";

/** Line lengths per ICAO format — anything else is not an MRZ line. */
const MRZ_LINE_LENGTHS = new Set([30, 36, 44]);

/**
 * OCR confusions the MRZ character set makes unambiguous: the zone holds only A–Z, 0–9 and
 * `<`, so a lone `«`, `k`, or `(` is `<`, and lowercase is uppercase. Digits-vs-letters
 * (0/O, 1/I, 5/S, 8/B) are NOT swapped blindly — the parser's check digits decide.
 */
export function cleanMrzLine(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«»(){}\[\]|!\\/]/g, "<")
    .replace(/[^A-Z0-9<]/g, "")
    .trim();
}

/**
 * Pull candidate MRZ lines out of free OCR text: keep lines that, once cleaned, have a valid
 * MRZ length and look like the zone (`<` fillers or a leading document-code pattern). Returns
 * the best 2- or 3-line group, or null.
 */
export function extractMrzLines(ocrText: string): string[] | null {
  const cleaned = ocrText
    .split(/\r?\n/)
    .map(cleanMrzLine)
    .filter((l) => l.length >= 28);
  // Pad/trim to a canonical length when OCR dropped or added a filler at the end.
  const norm = cleaned.map((l) => {
    for (const len of [44, 36, 30]) {
      if (l.length === len) return l;
      if (l.length > len - 3 && l.length < len) return l.padEnd(len, "<");
      if (l.length > len && l.length <= len + 2) return l.slice(0, len);
    }
    return l;
  });
  // A two-line strip (TD3 / TD2) found by its first line (2026-10-29): "P<IND…" with the name
  // fillers, and the line after it of the same length — the second line of a passport often holds
  // no "<<" at all (the personal number fills it), and was dropped, so the strip was never parsed.
  for (let i = norm.length - 2; i >= 0; i--) {
    const a = norm[i];
    const b = norm[i + 1];
    if ((a.length === 44 || a.length === 36) && b.length === a.length && /^[PV]/.test(a) && a.includes("<<")) return [a, b];
  }
  const candidates = norm.filter((l) => MRZ_LINE_LENGTHS.has(l.length) && (l.includes("<<") || /^[PIACV]/.test(l)));
  if (candidates.length < 2) return null;
  // Prefer the LAST lines (the MRZ sits at the foot of the page); TD3 = 2×44, TD1 = 3×30, TD2 = 2×36.
  const tail3 = candidates.slice(-3);
  if (tail3.length === 3 && tail3.every((l) => l.length === 30)) return tail3;
  const tail2 = candidates.slice(-2);
  if (tail2[0].length === tail2[1].length && (tail2[0].length === 44 || tail2[0].length === 36)) return tail2;
  return null;
}

/* ------------------------------------------------------------ a misread put right by its check digit */

/** ICAO 9303 check digit: weights 7, 3, 1; `<` is 0, A–Z are 10–35. */
function checkDigitOf(field: string): number {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    const v = c === "<" ? 0 : c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
    sum += v * w[i % 3];
  }
  return sum % 10;
}
const passes = (field: string, check: string) => /^\d$/.test(check) && checkDigitOf(field) === Number(check);

/** What OCR-B reads one character as, and what it may really be (2026-10-29 — the Z of "Z7286983" read as 7). */
const LOOKALIKE: Record<string, string> = {
  "0": "OQD", O: "0QD", Q: "O0", D: "0O",
  "1": "ILZ7T", I: "1", L: "1I",
  "2": "Z", Z: "27",
  "5": "S", S: "5",
  "6": "G", G: "6",
  "7": "ZT1", T: "7",
  "8": "B", B: "8",
  "4": "A", A: "4",
};
const AS_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", T: "7", B: "8", A: "4" };
const AS_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "7": "T", "8": "B", "4": "A" };

/** A field that must be digits (a date, a check digit) — a letter there is the digit it looks like. */
function asDigits(v: string): string {
  return v.replace(/[A-Z]/g, (c) => AS_DIGIT[c] ?? c);
}
/** A field that must be letters (a country, a name) — a digit there is the letter it looks like. */
function asLetters(v: string): string {
  return v.replace(/[0-9]/g, (c) => AS_LETTER[c] ?? c);
}

/**
 * The field as read when its check digit passes; else every way of changing ONE character for its
 * look-alike that makes it pass (often more than one — the strip's composite check then chooses).
 */
function fixesFor(field: string, check: string, shape: RegExp): string[] {
  if (passes(field, check)) return [field];
  const found = new Set<string>();
  for (let i = 0; i < field.length; i++) {
    for (const alt of LOOKALIKE[field[i]] ?? "") {
      const next = field.slice(0, i) + alt + field.slice(i + 1);
      if (passes(next, check) && shape.test(next)) found.add(next);
    }
  }
  return [...found];
}

/**
 * What each field may look like once put right. A date is six digits. A passport number is letters
 * then digits (2026-10-29): India's is one letter and seven digits — "Z7286983" read as "77286983"
 * has two fixes its check digit cannot tell apart, Z7286983 and 7T286983, and only the first is a
 * passport number. The composite check adds nothing between them: it weighs those characters alike.
 */
const DATE_SHAPE = /^\d{6}$/;
const NUMBER_SHAPE = /^[A-Z]{0,3}\d+<*$/;

/**
 * A two-line passport strip (TD3) with its misreads put right (2026-10-29, operator: "the passport
 * band is clearly visible yet it only detected passport, DOB and sex"). The strip reader saw the Z
 * of Z7286983 as a 7, the number's check digit failed, and the whole strip was set aside. Each
 * field is read as the kind it must be — a date is digits, a country is letters — and a field
 * still short of its check digit may have ONE character changed for its look-alike where that
 * makes its check pass. The strip's own composite check digit chooses among those fixes: exactly
 * one combination must pass it, or nothing is changed. Lines that are not a TD3 strip come back as given.
 */
export function repairTd3(lines: string[]): string[] {
  if (lines.length !== 2 || lines[0].length !== 44 || lines[1].length !== 44) return lines;
  const l1 = lines[0];
  const l2 = lines[1];
  if (!/^[PV]/.test(l1)) return lines;
  // Line 1: the document code, the issuing country (letters), the names (letters and fillers).
  const r1 = l1.slice(0, 2) + asLetters(l1.slice(2, 5)) + asLetters(l1.slice(5));
  const num = l2.slice(0, 9);
  const numCheck = asDigits(l2.slice(9, 10));
  // The nationality is the issuing country on almost every passport: one letter off it ("INP" on an
  // Indian strip, 2026-10-29) is that country misread. It carries no check digit — it stays READ.
  const issuing = asLetters(l1.slice(2, 5));
  const natRead = asLetters(l2.slice(10, 13));
  const offByOne = [...natRead].filter((c, i) => c !== issuing[i]).length === 1;
  const nat = offByOne && /^[A-Z]{3}$/.test(issuing) ? issuing : natRead;
  const dob = asDigits(l2.slice(13, 19));
  const dobCheck = asDigits(l2.slice(19, 20));
  const sex = l2.slice(20, 21).replace("H", "M");
  const exp = asDigits(l2.slice(21, 27));
  const expCheck = asDigits(l2.slice(27, 28));
  const personal = l2.slice(28, 42);
  const personalCheck = l2.slice(42, 43).replace(/[A-Z]/g, (c) => AS_DIGIT[c] ?? c);
  const composite = asDigits(l2.slice(43, 44));
  // Every combination of the fields' fixes; the composite check — over the number, the birth date,
  // the expiry and the personal number with their checks — must pass, and exactly one combination
  // may: a guess between two is no proof.
  // A field no single change can prove is kept as read.
  const optionsFor = (f: string, c: string, shape: RegExp) => {
    const x = fixesFor(f, c, shape);
    return x.length ? x : [f];
  };
  const line = (n: string, d: string, e: string) => n + numCheck + nat + d + dobCheck + sex + e + expCheck + personal + personalCheck + composite;
  const fits: string[] = [];
  for (const n of optionsFor(num, numCheck, NUMBER_SHAPE))
    for (const d of optionsFor(dob, dobCheck, DATE_SHAPE))
      for (const e of optionsFor(exp, expCheck, DATE_SHAPE)) {
        const r = line(n, d, e);
        if (passes(r.slice(0, 10) + r.slice(13, 20) + r.slice(21, 43), composite)) fits.push(r);
      }
  const r2 = fits.length === 1 ? fits[0] : l2;
  if (r2 === l2 && r1 === l1) return lines;
  return [r1, r2];
}

function isoFromYYMMDD(v: string | null | undefined, kind: "birth" | "expiry", now = new Date()): string | undefined {
  if (!v || !/^\d{6}$/.test(v)) return undefined;
  const yy = Number(v.slice(0, 2));
  const mm = v.slice(2, 4);
  const dd = v.slice(4, 6);
  const curYY = now.getUTCFullYear() % 100;
  const century = 2000;
  // Birth dates in the future are impossible → previous century; expiries are (nearly) always
  // 20xx — a passport expiring in "99" is 2099-not-1999 only if it were issued 90 years long,
  // so treat expiries below the current 2-digit year minus 10 as already-lapsed 20xx anyway.
  const year = kind === "birth" ? (yy > curYY ? 1900 + yy : century + yy) : century + yy;
  return `${year}-${mm}-${dd}`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Parse cleaned MRZ lines. Returns null when the lines are not a recognisable MRZ at all;
 * otherwise an extraction whose per-field confidence is VERIFIED only where the parser's
 * check digit for that field passed.
 */
export function parseMrzLines(lines: string[], now = new Date()): IdentityExtraction | null {
  let result: ReturnType<typeof parseMrz>;
  // A misread character put right by its check digit first (2026-10-29) — see repairTd3.
  const cleaned = repairTd3(lines.map(cleanMrzLine));
  try {
    result = parseMrz(cleaned);
  } catch {
    return null;
  }
  const valid = new Map<string, boolean>(result.details.map((d) => [String(d.field), d.valid]));
  const f = result.fields;
  const fields: IdentitySuggestedFields = {};
  const conf: IdentityExtraction["fieldConfidence"] = {};
  const put = <K extends keyof IdentitySuggestedFields>(key: K, value: string | undefined, checkKeys: string[]) => {
    if (!value) return;
    fields[key] = value;
    conf[key] = checkKeys.every((k) => valid.get(k) === true) ? ("VERIFIED" as FieldConfidence) : "READ";
  };

  // Document type: only a passport ('P…') maps into the hotel vocabulary; ID-card MRZs (TD1)
  // carry no code we can honestly map to CID/Aadhaar/etc.
  if (f.documentCode?.startsWith("P")) {
    fields.documentType = "PASSPORT";
    conf.documentType = "VERIFIED";
  }
  put("documentNumber", f.documentNumber ?? undefined, ["documentNumber", "documentNumberCheckDigit"]);
  const name = [f.firstName, f.lastName].filter(Boolean).join(" ");
  // No check digit covers the names (2026-10-23): a misread name parsed "valid" and was shown as
  // proven. They are READ like any other OCR'd text.
  if (name) {
    fields.fullName = titleCase(name);
    conf.fullName = "READ";
  }
  put("dateOfBirth", isoFromYYMMDD(f.birthDate, "birth", now), ["birthDate", "birthDateCheckDigit"]);
  put("expiryDate", isoFromYYMMDD(f.expirationDate, "expiry", now), ["expirationDate", "expirationDateCheckDigit"]);
  // The sex and the nationality carry no check digit either (2026-10-23: a strip read "NBD" for
  // IND and it showed as proven) — READ.
  const sex = f.sex === "male" ? "M" : f.sex === "female" ? "F" : f.sex ? "X" : undefined;
  if (sex) {
    fields.gender = sex;
    conf.gender = "READ";
  }
  if (f.nationality) {
    fields.nationality = f.nationality;
    conf.nationality = "READ";
  }

  const empty = Object.keys(fields).length === 0;
  const repaired = cleaned.some((l, i) => l !== cleanMrzLine(lines[i] ?? ""));
  return { fields, fieldConfidence: conf, raw: { mrzLines: cleaned, source: `MRZ ${result.format}${repaired ? " · a misread put right by its check digit" : ""}` }, empty };
}
