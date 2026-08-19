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
  const candidates = norm.filter((l) => MRZ_LINE_LENGTHS.has(l.length) && (l.includes("<<") || /^[PIACV]/.test(l)));
  if (candidates.length < 2) return null;
  // Prefer the LAST lines (the MRZ sits at the foot of the page); TD3 = 2×44, TD1 = 3×30, TD2 = 2×36.
  const tail3 = candidates.slice(-3);
  if (tail3.length === 3 && tail3.every((l) => l.length === 30)) return tail3;
  const tail2 = candidates.slice(-2);
  if (tail2[0].length === tail2[1].length && (tail2[0].length === 44 || tail2[0].length === 36)) return tail2;
  return null;
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
  try {
    result = parseMrz(lines.map(cleanMrzLine));
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
  put("fullName", name ? titleCase(name) : undefined, ["firstName", "lastName"]);
  put("dateOfBirth", isoFromYYMMDD(f.birthDate, "birth", now), ["birthDate", "birthDateCheckDigit"]);
  put("expiryDate", isoFromYYMMDD(f.expirationDate, "expiry", now), ["expirationDate", "expirationDateCheckDigit"]);
  const sex = f.sex === "male" ? "M" : f.sex === "female" ? "F" : f.sex ? "X" : undefined;
  put("gender", sex, ["sex"]);
  put("nationality", f.nationality ?? undefined, ["nationality"]);

  const empty = Object.keys(fields).length === 0;
  return { fields, fieldConfidence: conf, raw: { mrzLines: lines, source: `MRZ ${result.format}` }, empty };
}
