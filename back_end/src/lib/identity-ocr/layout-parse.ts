/**
 * Phase B — label-anchored parsing of free OCR text (2026-08-18).
 *
 * Documents with no MRZ and no usable QR (Bhutanese CID, Indian voter card, birth
 * certificates) print English field LABELS next to their values: "ID No.", "Name",
 * "Date of Birth", "Sex" … This module turns an OCR engine's output — a list of text
 * lines/regions in reading order — into suggested fields by (1) detecting the document
 * type from keywords and (2) anchoring each field on its label: the value is the text
 * after the label on the same line, or the next line when the label stands alone.
 *
 * Every value is READ (never VERIFIED) — nothing on these documents proves a field the way
 * an MRZ check digit does. Engine-agnostic: Florence-2 regions, tesseract lines, or a
 * VLM's dump all feed the same function.
 */
import type { IdentityExtraction, IdentitySuggestedFields } from "./types.js";

export type LayoutDocKind = "CID" | "VOTER_CARD" | "BIRTH_CERTIFICATE" | "WORK_PERMIT" | "PASSPORT" | "AADHAAR_CARD" | null;

/** Title phrases weigh 2 (they name the document); issuer/field words weigh 1; words shared
 *  across many Indian documents ("GOVERNMENT OF INDIA") weigh 0.3 so they only break ties.
 *  "KINGDOM OF BHUTAN" prints on BOTH the CID and the work permit, so it weighs 1 on each —
 *  the title phrase ("WORK PERMIT" / "CITIZENSHIP IDENTITY CARD") is what separates them. */
type Kw = { kind: Exclude<LayoutDocKind, null>; patterns: Array<[RegExp, number]> };
const DOC_KEYWORDS: Kw[] = [
  { kind: "CID", patterns: [[/CITIZENSHIP\s+IDENTITY\s+CARD/i, 2], [/KINGDOM OF BHUTAN/i, 1], [/ROYAL GOVERNMENT OF BHUTAN/i, 1], [/\bCID\b/i, 1], [/DZONGKHAG/i, 1], [/GEWOG/i, 1]] },
  { kind: "VOTER_CARD", patterns: [[/ELECTOR'?S?\s+PHOTO\s+IDENTITY/i, 2], [/ELECTION COMMISSION/i, 1], [/\bEPIC\b/i, 1], [/VOTER/i, 1]] },
  { kind: "BIRTH_CERTIFICATE", patterns: [[/BIRTH\s+CERTIFICATE/i, 2], [/CERTIFICATE\s+OF\s+BIRTH/i, 2], [/REGISTRATION\s+OF\s+BIRTH/i, 1], [/NAME\s+OF\s+(?:THE\s+)?CHILD/i, 1]] },
  // Bhutanese work permit (Dept. of Immigration card carried by foreign workers — a common
  // guest ID at the desk): "WORK PERMIT" title, Job Category / Employer / Location labels,
  // a 12-digit permit number printed without a label, Issue/Valid dates.
  { kind: "WORK_PERMIT", patterns: [[/WORK\s+PERMIT/i, 2], [/JOB\s+CATEGORY/i, 1], [/\bEMPLOYER\b/i, 1], [/DEPARTMENT\s+OF\s+IMMIGRATION/i, 1], [/KINGDOM OF BHUTAN/i, 1]] },
  { kind: "AADHAAR_CARD", patterns: [[/AADHAAR/i, 2], [/UNIQUE IDENTIFICATION/i, 1], [/UIDAI/i, 1], [/GOVERNMENT OF INDIA/i, 0.3]] },
  { kind: "PASSPORT", patterns: [[/\bPASSPORT\b/i, 2], [/REPUBLIC OF INDIA/i, 0.3]] },
];

/** Which document this text belongs to, by keyword vote (ties → null). */
export function detectLayoutDocKind(text: string): LayoutDocKind {
  const scores = new Map<string, number>();
  for (const d of DOC_KEYWORDS) {
    let n = 0;
    for (const [p, w] of d.patterns) if (p.test(text)) n += w;
    if (n > 0) scores.set(d.kind, n);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0] as LayoutDocKind;
}

type Anchor = {
  field: keyof IdentitySuggestedFields;
  labels: RegExp[];
  value: RegExp;
  clean?: (v: string) => string | undefined;
  /** A pattern distinctive enough to accept WITHOUT a label (an EPIC number, an 11-digit CID). */
  loose?: RegExp;
};

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12" };

/** dd/mm/yyyy · dd-mm-yyyy · dd.mm.yyyy · yyyy-mm-dd · 12 Aug 1990 · Aug 12, 1990 → ISO. */
export function normaliseDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = s.match(/(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${MONTHS[m[2].slice(0, 3).toLowerCase()]}-${m[1].padStart(2, "0")}`;
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${MONTHS[m[1].slice(0, 3).toLowerCase()]}-${m[2].padStart(2, "0")}`;
  return undefined;
}

function normaliseGender(raw: string): string | undefined {
  const g = raw.trim().toUpperCase();
  if (/^(M|MALE)\b/.test(g)) return "M";
  if (/^(F|FEMALE)\b/.test(g)) return "F";
  if (/^(O|OTHER|X)\b/.test(g)) return "X";
  return undefined;
}

function cleanName(raw: string): string | undefined {
  // A merged OCR row can run the name into the NEXT label ("Ayansh Dwivedy Sex Male") —
  // cut at the first following label word before anything else.
  let s = raw.split(/\b(?:sex|gender|date\s+of\s+birth|place\s+of\s+birth|d\.?o\.?b)\b/i)[0];
  s = s
    .replace(/[^A-Za-z .'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2) return undefined;
  // A label fragment is not a name ("of the Child", "Date of Birth") — nor is a stray
  // gender value picked off a neighbouring line.
  if (/^(of|the|date|birth|sex|gender|name|no|number|id|male|female)\b/i.test(s) || /\b(date of birth|of the child)\b/i.test(s)) return undefined;
  // Title-case an all-caps name; keep mixed case as printed.
  const words = s.split(" ").filter(Boolean);
  if (words.length > 6) return undefined;
  const cased = s === s.toUpperCase() ? words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ") : s;
  return cased;
}

function cleanIdNumber(raw: string): string | undefined {
  const s = raw.replace(/[^A-Za-z0-9/-]/g, "").toUpperCase();
  if (s.length < 5) return undefined;
  // Words aren't numbers ("REGISTRATION" off a bare label line), and a date isn't an id —
  // both are what the wider candidate scan would otherwise pick up around a lone label.
  if ((s.match(/\d/g)?.length ?? 0) < 2) return undefined;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(s) || /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(s)) return undefined;
  return s;
}

function cleanNationality(raw: string): string | undefined {
  const s = raw
    .replace(/[^A-Za-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 3 || s.split(" ").length > 3) return undefined;
  // A neighbouring label is not a nationality.
  if (/^(job|category|employer|location|name|date|sex|gender|id|no|number)\b/i.test(s)) return undefined;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const ANCHORS: Record<Exclude<LayoutDocKind, null | "PASSPORT" | "AADHAAR_CARD">, Anchor[]> = {
  CID: [
    // Bhutan CID: "ID No." / "ID No: 11410001234" — 11 digits.
    { field: "documentNumber", labels: [/\bID\s*NO\.?\s*:?/i, /\bIDENTITY\s*NO\.?\s*:?/i, /\bCID\s*NO\.?\s*:?/i, /\bCID\s*:?/i], value: /(\d[\d ]{9,14}\d)/, clean: (v) => v.replace(/\s/g, ""), loose: /\b(\d{11})\b/ },
    { field: "fullName", labels: [/\bNAME\s*:?/i], value: /([A-Za-z][A-Za-z .'\-]{1,60})/, clean: cleanName },
    { field: "dateOfBirth", labels: [/DATE\s*OF\s*BIRTH\s*:?/i, /\bD\.?O\.?B\.?\s*:?/i, /\bBIRTH\s*DATE\s*:?/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/, clean: normaliseDate },
    { field: "gender", labels: [/\bSEX\s*:?/i, /\bGENDER\s*:?/i], value: /(MALE|FEMALE|OTHER|\bM\b|\bF\b)/i, clean: normaliseGender },
    { field: "expiryDate", labels: [/DATE\s*OF\s*EXPIRY\s*:?/i, /\bEXPIRY\s*(?:DATE)?\s*:?/i, /VALID\s*(?:UP\s*)?TO\s*:?/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/, clean: normaliseDate },
  ],
  VOTER_CARD: [
    // EPIC number: 3 letters + 7 digits (e.g. ABC1234567), sometimes printed as "ABC/12/345/678".
    { field: "documentNumber", labels: [/\bEPIC\s*(?:NO\.?)?\s*:?/i, /\bID\s*NO\.?\s*:?/i, /\bNO\.?\s*:?/i], value: /([A-Z]{3}[ /]?\d{7}|[A-Z]{2,3}\/\d{2}\/\d{3}\/\d{6})/i, clean: cleanIdNumber, loose: /\b([A-Z]{3}\d{7})\b/ },
    { field: "fullName", labels: [/ELECTOR'?S?\s+NAME\s*:?/i, /\bNAME\s*:?/i], value: /([A-Za-z][A-Za-z .'\-]{1,60})/, clean: cleanName },
    { field: "dateOfBirth", labels: [/DATE\s*OF\s*BIRTH\s*:?/i, /\bD\.?O\.?B\.?\s*:?/i, /\bAGE\s*AS\s*ON/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2})/, clean: normaliseDate },
    { field: "gender", labels: [/\bSEX\s*:?/i, /\bGENDER\s*:?/i], value: /(MALE|FEMALE|OTHER|\bM\b|\bF\b)/i, clean: normaliseGender },
  ],
  BIRTH_CERTIFICATE: [
    // Karnataka Form-5 prints "613357/V/B/2015/001334" beside the Kannada label with the
    // English "Registration No.:" alone underneath — the loose slash-separated shape is
    // distinctive enough to accept from anywhere on the page.
    // No bare "No." label here — it matched "Flat No E-006" in the parents' address block
    // and returned the house number as the certificate number.
    { field: "documentNumber", labels: [/REGISTRATION\s*(?:NO|NUMBER)\.?\s*:?/i, /CERTIFICATE\s*(?:NO|NUMBER)\.?\s*:?/i, /\bREG\.?\s*NO\.?\s*:?/i], value: /([A-Z0-9][A-Z0-9/-]{4,30})/i, clean: cleanIdNumber, loose: /\b(\d{4,8}(?:\/[A-Z0-9]{1,6}){2,6})\b/i },
    // "Name" must not anchor on "Name of Mother" / "Name of Father" — those are the
    // PARENTS' rows; the child's own row is plain "Name".
    { field: "fullName", labels: [/NAME\s*OF\s*(?:THE\s*)?CHILD\s*:?/i, /CHILD'?S?\s+NAME\s*:?/i, /\bNAME\b(?!\s*of\s*(?:the\s*)?(?:mother|father|child))\s*:?/i], value: /([A-Za-z][A-Za-z .'\-]{1,60})/, clean: cleanName },
    { field: "dateOfBirth", labels: [/DATE\s*OF\s*BIRTH\s*:?/i, /\bBORN\s*ON\s*:?/i, /\bD\.?O\.?B\.?\s*:?/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/, clean: normaliseDate },
    { field: "gender", labels: [/\bSEX\s*:?/i, /\bGENDER\s*:?/i], value: /(MALE|FEMALE|OTHER|\bM\b|\bF\b)/i, clean: normaliseGender },
  ],
  WORK_PERMIT: [
    // The 12-digit permit number prints WITHOUT a label (bottom-left of the card), so the
    // loose pattern carries most reads; "Permit No" covers other layouts. 11–13 digits so a
    // marginal OCR drop/extra doesn't lose the whole number.
    { field: "documentNumber", labels: [/PERMIT\s*NO\.?\s*:?/i, /\bWP\s*NO\.?\s*:?/i, /\bID\s*NO\.?\s*:?/i], value: /(\d[\d ]{9,15}\d)/, clean: (v) => v.replace(/\s/g, ""), loose: /\b(\d{11,13})\b/ },
    { field: "fullName", labels: [/\bNAME\s*:?/i], value: /([A-Za-z][A-Za-z .'\-]{1,60})/, clean: cleanName },
    { field: "dateOfBirth", labels: [/DATE\s*OF\s*BIRTH\s*:?/i, /\bD\.?O\.?B\.?\s*:?/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/, clean: normaliseDate },
    { field: "nationality", labels: [/NATIONALITY\s*:?/i], value: /([A-Za-z][A-Za-z ]{2,30})/, clean: cleanNationality },
    { field: "gender", labels: [/\bSEX\s*:?/i, /\bGENDER\s*:?/i], value: /(MALE|FEMALE|OTHER|\bM\b|\bF\b)/i, clean: normaliseGender },
    // "Valid Date: 27-08-2026" — the permit's own validity is the document expiry.
    { field: "expiryDate", labels: [/VALID\s*(?:DATE|UP\s*TO|TILL|UNTIL)\s*:?/i, /\bEXPIRY\s*(?:DATE)?\s*:?/i], value: /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{4}|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/, clean: normaliseDate },
  ],
};

/**
 * Anchor a field: find the label in a line; take the value from the remainder of that
 * line, else from the next non-empty lines (labels often stand alone on cards), else from
 * the PRECEDING lines — bilingual certificates (e.g. Karnataka's Form-5 birth certificate)
 * print the value beside the native-script label with the English label BELOW it, so the
 * value sits a line or three ABOVE the anchor.
 */
function anchorField(lines: string[], a: Anchor): string | undefined {
  const allAnchors = Object.values(ANCHORS).flat();
  const isLabelLine = (s: string) => allAnchors.some((x) => x.labels.some((l) => l.test(s.slice(0, 24))));
  const tryValue = (c: string): string | undefined => {
    const v = a.value.exec(c);
    if (!v?.[1]) return undefined;
    return a.clean ? a.clean(v[1]) : v[1].trim();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of a.labels) {
      const m = label.exec(line);
      if (!m) continue;
      const rest = line.slice(m.index + m[0].length).trim();
      if (rest) {
        const r = tryValue(rest);
        if (r) return r;
      }
      // Below the label — stop at the next label line (its text is not OUR value).
      for (const c of [lines[i + 1] ?? "", lines[i + 2] ?? ""]) {
        if (!c.trim()) continue;
        if (isLabelLine(c)) break;
        const r = tryValue(c);
        if (r) return r;
      }
      // Above the label — skip other labels' lines but keep looking (the value-bearing
      // native-script line sits past the neighbouring column's regions in reading order).
      for (const c of [lines[i - 1] ?? "", lines[i - 2] ?? "", lines[i - 3] ?? ""]) {
        if (!c.trim() || isLabelLine(c)) continue;
        const r = tryValue(c);
        if (r) return r;
      }
    }
  }
  if (a.loose) {
    for (const line of lines) {
      const m = a.loose.exec(line);
      if (m?.[1]) {
        const cleaned = a.clean ? a.clean(m[1]) : m[1];
        if (cleaned) return cleaned;
      }
    }
  }
  return undefined;
}

/**
 * Parse OCR lines (reading order) into a suggestion. `kindHint` (e.g. the desk row's picked
 * type) fills in when keyword DETECTION fails — never the other way round: the document's
 * own title outranks a hint, since the desk row may name a different document than the one
 * actually photographed (found live: a work permit analysed under a CID-labelled row parsed
 * as CID). Returns null when neither a document kind nor any field could be found.
 */
export function parseLayoutText(lines: string[], kindHint: LayoutDocKind = null): IdentityExtraction | null {
  const clean = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = clean.join("\n");
  const kind = detectLayoutDocKind(text) ?? kindHint;
  const fields: IdentitySuggestedFields = {};
  const conf: IdentityExtraction["fieldConfidence"] = {};
  if (kind && kind !== "PASSPORT" && kind !== "AADHAAR_CARD") {
    fields.documentType = kind;
    conf.documentType = "READ";
    for (const a of ANCHORS[kind]) {
      const v = anchorField(clean, a);
      if (v) {
        fields[a.field] = v;
        conf[a.field] = "READ";
      }
    }
  } else if (kind === "PASSPORT" || kind === "AADHAAR_CARD") {
    // A passport / Aadhaar that reached the layout pass means its MRZ / QR was NOT readable
    // — still record the type, and try the generic anchors for whatever prints in clear.
    fields.documentType = kind;
    conf.documentType = "READ";
    for (const a of ANCHORS.CID) {
      if (a.field === "documentNumber") continue; // CID's 11-digit rule doesn't apply
      const v = anchorField(clean, a);
      if (v) {
        fields[a.field] = v;
        conf[a.field] = "READ";
      }
    }
  } else {
    // Unknown document: only fields whose labels are unambiguous across all layouts.
    for (const a of [...ANCHORS.CID].filter((x) => x.field === "dateOfBirth" || x.field === "gender" || x.field === "fullName")) {
      const v = anchorField(clean, a);
      if (v) {
        fields[a.field] = v;
        conf[a.field] = "READ";
      }
    }
  }
  const empty = Object.keys(fields).length === 0;
  if (empty) return null;
  return { fields, fieldConfidence: conf, raw: { source: `LAYOUT ${kind ?? "UNKNOWN"}` }, empty: false };
}
