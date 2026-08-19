/**
 * Aadhaar QR → suggested fields (2026-08-18).
 *
 * Every Aadhaar card/letter/e-Aadhaar carries a QR code. Two generations exist:
 *  - Legacy XML: `<PrintLetterBarcodeData uid="…" name="…" gender="M" yob="1990" dob="…"/>`
 *    — carries the FULL number.
 *  - Secure QR (2018+): one very large decimal integer → big-endian bytes → gzip →
 *    0xFF-separated fields (version marker, email/mobile flag, reference id, name, DOB,
 *    gender, address parts…, then a JPEG photo and a 256-byte UIDAI signature). It carries
 *    only the LAST FOUR digits of the Aadhaar number (first 4 chars of the reference id).
 *
 * The QR is decoded on the phone or by the server; this module turns the decoded TEXT into
 * fields. UIDAI signature verification is NOT performed here (that needs the UIDAI public
 * certificate), so the values are marked READ, not VERIFIED — the operator confirms them.
 */
import { gunzipSync, inflateSync } from "node:zlib";
import type { IdentityExtraction, IdentitySuggestedFields } from "./types.js";

function isoFromIndianDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  // dd-mm-yyyy or dd/mm/yyyy
  const m = v.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const iso = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];
  return undefined;
}

function normGender(v: string | undefined): string | undefined {
  const g = v?.trim().toUpperCase();
  if (!g) return undefined;
  if (g.startsWith("M")) return "M";
  if (g.startsWith("F")) return "F";
  return "X";
}

function fromLegacyXml(text: string): IdentityExtraction | null {
  if (!/PrintLetterBarcodeData/i.test(text)) return null;
  const attr = (name: string) => text.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1]?.trim();
  const uid = attr("uid");
  const name = attr("name");
  const fields: IdentitySuggestedFields = { documentType: "AADHAAR_CARD" };
  if (uid && /^\d{12}$/.test(uid)) fields.documentNumber = uid;
  if (name) fields.fullName = name;
  fields.dateOfBirth = isoFromIndianDate(attr("dob")) ?? (attr("yob") ? `${attr("yob")}-01-01` : undefined);
  if (!fields.dateOfBirth) delete fields.dateOfBirth;
  const g = normGender(attr("gender"));
  if (g) fields.gender = g;
  const conf: IdentityExtraction["fieldConfidence"] = {};
  for (const k of Object.keys(fields) as (keyof IdentitySuggestedFields)[]) conf[k] = "READ";
  return { fields, fieldConfidence: conf, raw: { qrText: text, source: "AADHAAR_QR_XML" }, empty: false };
}

function bigDecimalToBytes(dec: string): Uint8Array {
  let n = BigInt(dec);
  const out: number[] = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(out.reverse());
}

function fromSecureQr(text: string): IdentityExtraction | null {
  const dec = text.trim();
  if (!/^\d{200,}$/.test(dec)) return null;
  let bytes: Buffer;
  try {
    const packed = Buffer.from(bigDecimalToBytes(dec));
    try {
      bytes = gunzipSync(packed);
    } catch {
      bytes = inflateSync(packed);
    }
  } catch {
    return null;
  }
  // Split the leading text fields on 0xFF; stop well before the photo/signature.
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length && parts.length < 20; i++) {
    if (bytes[i] === 0xff) {
      parts.push(bytes.subarray(start, i).toString("latin1"));
      start = i + 1;
    }
  }
  if (parts.length < 5) return null;
  // V2/V3/V4 secure QRs prefix a version marker; V1 starts straight with the flag digit.
  const offset = /^V\d$/i.test(parts[0]) ? 1 : 0;
  const referenceId = parts[offset + 1] ?? "";
  const name = parts[offset + 2]?.trim();
  const dob = parts[offset + 3]?.trim();
  const gender = parts[offset + 4]?.trim();
  const fields: IdentitySuggestedFields = { documentType: "AADHAAR_CARD" };
  const last4 = referenceId.match(/^(\d{4})/)?.[1];
  if (last4) fields.documentNumberLast4 = last4;
  if (name) fields.fullName = name;
  const iso = isoFromIndianDate(dob);
  if (iso) fields.dateOfBirth = iso;
  const g = normGender(gender);
  if (g) fields.gender = g;
  const conf: IdentityExtraction["fieldConfidence"] = {};
  for (const k of Object.keys(fields) as (keyof IdentitySuggestedFields)[]) conf[k] = "READ";
  return { fields, fieldConfidence: conf, raw: { qrText: dec.slice(0, 64) + "…", source: "AADHAAR_SECURE_QR" }, empty: false };
}

/** Parse an AADHAAR QR specifically (legacy XML or Secure QR). Null when it is neither. */
export function parseAadhaarQrText(text: string): IdentityExtraction | null {
  return fromLegacyXml(text) ?? fromSecureQr(text);
}

// ─── Generic QR (2026-08-17, operator ruling: "any ID with a QR code should work") ───────
// Many IDs carry a QR that is NOT Aadhaar's format — Bhutanese work permits, driving
// licences, newer voter cards. Their payloads vary: JSON, XML attributes, key:value text,
// a verification URL, or just the document number. Best-effort extraction of whatever
// recognisable fields the payload carries; everything READ (nothing here is signed-verified).

const KEY_ALIASES: Record<keyof Pick<IdentitySuggestedFields, "fullName" | "dateOfBirth" | "gender" | "documentNumber" | "nationality" | "expiryDate">, RegExp> = {
  fullName: /^(name|full[ _-]?name|holder[ _-]?name)$/i,
  dateOfBirth: /^(dob|d\.o\.b\.?|date[ _-]?of[ _-]?birth|birth[ _-]?date)$/i,
  gender: /^(gender|sex)$/i,
  documentNumber: /^(id|idno|id[ _-]?no|id[ _-]?number|number|no|uid|cid|epic|permit[ _-]?no|permit[ _-]?number|wp[ _-]?no|document[ _-]?no|document[ _-]?number|card[ _-]?no|licen[cs]e[ _-]?no|reg[ _-]?no)$/i,
  nationality: /^(nationality|citizenship|country)$/i,
  expiryDate: /^(expiry|expiry[ _-]?date|valid[ _-]?(?:date|to|till|until|upto))$/i,
};

function assignAlias(fields: IdentitySuggestedFields, key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  for (const [field, pattern] of Object.entries(KEY_ALIASES) as [keyof typeof KEY_ALIASES, RegExp][]) {
    if (!pattern.test(key.trim())) continue;
    if (fields[field]) return; // first hit wins
    if (field === "dateOfBirth" || field === "expiryDate") {
      const iso = isoFromIndianDate(v) ?? v.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (iso) fields[field] = iso;
    } else if (field === "gender") {
      const g = normGender(v);
      if (g) fields[field] = g;
    } else if (field === "documentNumber") {
      const n = v.replace(/[^A-Za-z0-9/-]/g, "");
      if (n.length >= 5) fields[field] = n.toUpperCase();
    } else {
      fields[field] = v.slice(0, 120);
    }
    return;
  }
}

/** A QR whose whole payload is one identifier ("132508270041") → the document number. */
function bareIdentifier(text: string): string | null {
  const t = text.trim();
  if (t.length < 5 || t.length > 32 || /\s/.test(t)) return null;
  if (!/^[A-Za-z0-9/-]+$/.test(t)) return null;
  if ((t.match(/\d/g)?.length ?? 0) < 4) return null; // words aren't numbers
  return t.toUpperCase();
}

function fromGenericQr(text: string): IdentityExtraction | null {
  const t = text.trim();
  if (!t) return null;
  const fields: IdentitySuggestedFields = {};
  let source = "GENERIC_QR";
  // JSON payload.
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const flat = (obj: unknown, out: Record<string, string> = {}): Record<string, string> => {
        if (obj && typeof obj === "object") {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            if (v && typeof v === "object") flat(v, out);
            else if (typeof v === "string" || typeof v === "number") out[k] = String(v);
          }
        }
        return out;
      };
      for (const [k, v] of Object.entries(flat(JSON.parse(t)))) assignAlias(fields, k, v);
      source = "GENERIC_QR_JSON";
    } catch {
      /* not JSON after all */
    }
  }
  // XML-ish attributes (any element, not just Aadhaar's).
  if (!Object.keys(fields).length && /<[^>]+>/.test(t)) {
    for (const m of t.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) assignAlias(fields, m[1], m[2]);
    if (Object.keys(fields).length) source = "GENERIC_QR_XML";
  }
  // A verification URL: read its query params.
  if (!Object.keys(fields).length && /^https?:\/\//i.test(t)) {
    try {
      for (const [k, v] of new URL(t).searchParams.entries()) assignAlias(fields, k, v);
      if (Object.keys(fields).length) source = "GENERIC_QR_URL";
    } catch {
      /* malformed URL */
    }
  }
  // key:value lines ("Name: X" / "DOB=..." — newline or ;|, separated).
  if (!Object.keys(fields).length && /[:=]/.test(t) && !/^https?:\/\//i.test(t)) {
    for (const part of t.split(/[\n;|,]+/)) {
      const m = part.match(/^\s*([A-Za-z][\w .-]{0,30}?)\s*[:=]\s*(.+)$/);
      if (m) assignAlias(fields, m[1], m[2]);
    }
    if (Object.keys(fields).length) source = "GENERIC_QR_KV";
  }
  // The whole payload is one identifier.
  if (!Object.keys(fields).length) {
    const id = bareIdentifier(t);
    if (id) {
      fields.documentNumber = id;
      source = "GENERIC_QR_ID";
    }
  }
  if (!Object.keys(fields).length) return null;
  const conf: IdentityExtraction["fieldConfidence"] = {};
  for (const k of Object.keys(fields) as (keyof IdentitySuggestedFields)[]) conf[k] = "READ";
  return { fields, fieldConfidence: conf, raw: { qrText: t.slice(0, 300), source }, empty: false };
}

/** Generic (non-Aadhaar) QR payload → whatever fields it recognisably carries. */
export function parseGenericQrText(text: string): IdentityExtraction | null {
  return fromGenericQr(text);
}

/**
 * Decode the TEXT of a QR found on an ID document: Aadhaar's two formats first (richest,
 * known layout), then the generic best-effort parse for any other ID's QR. Null when the
 * payload carries nothing recognisable.
 */
export function parseIdentityQrText(text: string): IdentityExtraction | null {
  return fromLegacyXml(text) ?? fromSecureQr(text) ?? fromGenericQr(text);
}
