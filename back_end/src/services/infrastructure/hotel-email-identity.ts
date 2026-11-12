/**
 * What the hotel's emails say about the hotel (2026-11-12): its name, where it is, the reservation
 * team's numbers and email, and its logo. One place, so the confirmation email's header and the
 * signature under every other email cannot print different numbers.
 *
 * Numbers: the hotel profile's, when one on file reads as a phone number; otherwise the reservation
 * team's, the numbers the confirmation email has always printed (operator, 2026-11-12: "use the
 * number in confirmation mails under reservation team"). The profile holds "+0000000000" on the
 * hotel's server and here, which is a placeholder and is never printed.
 *
 * Logo: the one the papers print (the profile's uploaded logo, else assets/legphel-logo-paper.png),
 * made small for email and attached inline by its content id — Gmail shows no image written into
 * an email's code as data.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { formatPhone, parsePhone } from "../../lib/phone-numbers.js";
import { documentExists, readDocument } from "../../lib/document-storage.js";

/** The numbers and email the confirmation email printed under "Reservation team". */
export const RESERVATION_TEAM = {
  phones: ["+975 17772393", "+975 77772393"],
  email: "legphel.hotel@gmail.com",
} as const;

/** The content id an email's HTML names the logo by: `<img src="cid:…">`. */
export const HOTEL_LOGO_CID = "hotel-logo@legphel";
/** The logo's file, relative to `back_end/` — the papers' own. */
const LOGO_FILE = "assets/legphel-logo-paper.png";
/** Twice the width it is shown at, so it is sharp on a phone. */
const LOGO_EMAIL_WIDTH = 128;

export type HotelEmailContact = {
  name: string;
  place: string | null;
  /** Stored form, "+975 17772393". */
  phones: string[];
  email: string;
};

const TTL_MS = 60_000;
let contactCache: { at: number; value: HotelEmailContact } | null = null;
let logoCache: { at: number; value: Buffer | null } | null = null;

/** "+975 17772393" as the hotel writes it on its emails: "(+975) 17772393". */
export function phoneOnEmail(stored: string): string {
  const m = stored.match(/^(\+\d{1,4})\s+(.+)$/);
  return m ? `(${m[1]}) ${m[2]}` : stored;
}

/** Every number on the profile that reads as a phone number, in its stored form. */
export function profilePhones(contactNumbers: unknown): string[] {
  const raw: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) raw.push(v);
  };
  if (typeof contactNumbers === "string") add(contactNumbers);
  else if (Array.isArray(contactNumbers)) {
    for (const v of contactNumbers) {
      if (typeof v === "string") add(v);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        add(o.value ?? o.number ?? o.phone);
      }
    }
  } else if (contactNumbers && typeof contactNumbers === "object") {
    for (const v of Object.values(contactNumbers as Record<string, unknown>)) add(v);
  }
  const out: string[] = [];
  for (const v of raw) {
    const parsed = parsePhone(v);
    // "+0000000000" is a placeholder, not a number.
    if (!parsed || parsed.sure === "UNCLEAR" || !/[1-9]/.test(parsed.number)) continue;
    const stored = formatPhone(parsed.code, parsed.number);
    if (!out.includes(stored)) out.push(stored);
  }
  return out;
}

/** An address a guest can write to: not a placeholder like "admin@legphel.local". */
function realEmail(v: string | null | undefined): string | null {
  const e = v?.trim();
  if (!e || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(e)) return null;
  if (/\.(local|test|example|invalid|localhost)$/i.test(e)) return null;
  return e;
}

export function emailContactFrom(profile: {
  hotelName?: string | null;
  tradingAddress?: string | null;
  registeredAddress?: string | null;
  contactNumbers?: unknown;
  primaryEmail?: string | null;
} | null): HotelEmailContact {
  const phones = profilePhones(profile?.contactNumbers);
  return {
    name: profile?.hotelName?.trim() || "Legphel Hotel",
    place: profile?.tradingAddress?.trim() || profile?.registeredAddress?.trim() || null,
    phones: phones.length ? phones : [...RESERVATION_TEAM.phones],
    email: realEmail(profile?.primaryEmail) ?? RESERVATION_TEAM.email,
  };
}

export async function loadEmailContact(prisma: PrismaClient): Promise<HotelEmailContact> {
  if (contactCache && Date.now() - contactCache.at < TTL_MS) return contactCache.value;
  let profile: Parameters<typeof emailContactFrom>[0] = null;
  try {
    profile = await prisma.hotelProfile.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { hotelName: true, tradingAddress: true, registeredAddress: true, contactNumbers: true, primaryEmail: true },
    });
  } catch {
    profile = null;
  }
  const value = emailContactFrom(profile);
  contactCache = { at: Date.now(), value };
  return value;
}

/** The logo as a small PNG for email, or null when none can be read (the email then has none). */
export async function loadEmailLogo(prisma: PrismaClient): Promise<Buffer | null> {
  if (logoCache && Date.now() - logoCache.at < TTL_MS) return logoCache.value;
  let bytes: Buffer | null = null;
  try {
    const row = await prisma.hotelProfile.findFirst({ orderBy: { updatedAt: "desc" }, select: { logoStorageKey: true } });
    if (row?.logoStorageKey && (await documentExists(row.logoStorageKey))) bytes = await readDocument(row.logoStorageKey);
  } catch {
    bytes = null;
  }
  try {
    if (!bytes) bytes = await readFile(resolve(process.cwd(), LOGO_FILE));
    bytes = await sharp(bytes).resize({ width: LOGO_EMAIL_WIDTH, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    bytes = null;
  }
  logoCache = { at: Date.now(), value: bytes };
  return bytes;
}

/** The logo's tag for an email's HTML; `width` is how wide it shows. */
export function logoImg(width: number, extraStyle = ""): string {
  return `<img src="cid:${HOTEL_LOGO_CID}" alt="Legphel Hotel" width="${width}" style="display:block;width:${width}px;height:auto;border:0;${extraStyle}"/>`;
}
