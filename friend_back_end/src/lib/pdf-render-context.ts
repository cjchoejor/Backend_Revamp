/**
 * Shared render-context loader — every bill template needs the hotel profile block
 * (name, address, phone, email, account no, TPN, GST TPN, logo) and often the
 * "Prepared by:" staff name. Centralised so a change here propagates to every template.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDocument, documentExists } from "./document-storage.js";

export type HotelProfileForRender = {
  hotelName: string;
  registeredAddress: string;
  tradingAddress: string | null;
  primaryEmail: string;
  contactNumbers: unknown; // JSON — usually { primary: "…", secondary: "…" } but shape is flexible
  accountNumber: string | null;
  tpnNumber: string | null;
  gstTpnNumber: string | null;
  /** Data URI (base64) for the logo image, ready to drop into <img src=…>. */
  logoDataUri: string | null;
  propertyCurrency: string;
};

/** Fallback logo path relative to repo root — the "no background" PNG the boss provided. */
const FALLBACK_LOGO_PATH = "images/legphel_logo without background.png";

async function loadLogoAsDataUri(prisma: PrismaClient, key: string | null): Promise<string | null> {
  // Preferred: HotelProfile.logoStorageKey set → read from the document-storage layer.
  if (key) {
    try {
      const exists = await documentExists(key);
      if (exists) {
        const bytes = await readDocument(key);
        return `data:image/png;base64,${bytes.toString("base64")}`;
      }
    } catch {
      // Fall through to the local reference image.
    }
  }
  // Fallback: the reference logo file shipped in the repo. Convenient during rollout
  // before the admin has uploaded the real logo via /admin/hotel-profile.
  try {
    // Resolved from the backend process's CWD which is `back_end/` — go up one level to
    // reach the repo root where `images/` lives.
    const path = resolve(process.cwd(), "..", FALLBACK_LOGO_PATH);
    const bytes = await readFile(path);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Load the active HotelProfile row + resolve the logo into a data URI in one shot. */
export async function loadHotelProfileForRender(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<HotelProfileForRender> {
  const row = await prisma.hotelProfile.findFirst({ orderBy: { updatedAt: "desc" } });
  if (!row) {
    // Ship-safe fallback so bills can still render before the admin has seeded HotelProfile.
    // Admin console flags a MISSING readiness check when this happens.
    return {
      hotelName: "LEGPHEL HOTEL",
      registeredAddress: "Phuentsholing, Bhutan",
      tradingAddress: null,
      primaryEmail: "legphel.hotel@gmail.com",
      contactNumbers: { primary: "+975-17772393" },
      accountNumber: null,
      tpnNumber: null,
      gstTpnNumber: null,
      logoDataUri: await loadLogoAsDataUri(prisma as PrismaClient, null),
      propertyCurrency: "BTN",
    };
  }
  const logoDataUri = await loadLogoAsDataUri(prisma as PrismaClient, row.logoStorageKey);
  return {
    hotelName: row.hotelName,
    registeredAddress: row.registeredAddress,
    tradingAddress: row.tradingAddress,
    primaryEmail: row.primaryEmail,
    contactNumbers: row.contactNumbers,
    accountNumber: row.accountNumber,
    tpnNumber: row.tpnNumber,
    gstTpnNumber: row.gstTpnNumber,
    logoDataUri,
    propertyCurrency: row.propertyCurrency,
  };
}

/** Look up the fullName of the actor rendering a bill — for the "Prepared by:" field. */
export async function getPreparedByName(
  prisma: PrismaClient | Prisma.TransactionClient,
  actorId: string,
): Promise<string> {
  if (!actorId || actorId === "SYSTEM") return "System";
  const staff = await prisma.staffUser.findUnique({
    where: { id: actorId },
    select: { fullName: true, username: true },
  });
  return staff?.fullName ?? staff?.username ?? actorId;
}

/**
 * Extract a primary phone from HotelProfile.contactNumbers. The column is JSON with flexible
 * shape — we tolerate several likely layouts so the admin can put whatever they want in.
 */
export function extractPrimaryPhone(contactNumbers: unknown): string {
  if (contactNumbers == null) return "";
  if (typeof contactNumbers === "string") return contactNumbers;
  if (Array.isArray(contactNumbers)) {
    const first = contactNumbers.find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  }
  if (typeof contactNumbers === "object") {
    const obj = contactNumbers as Record<string, unknown>;
    for (const k of ["primary", "phone", "main", "front_desk", "frontDesk"]) {
      if (typeof obj[k] === "string") return obj[k] as string;
    }
    for (const v of Object.values(obj)) if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Small helper for HTML strings — escape `<`, `>`, `&`, `"`, `'` so guest-supplied names
 * can't inject markup into the rendered template.
 */
export function htmlEscape(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format a Decimal / number / string as "1,234.56" (two decimals, thousand separator). */
export function formatMoney(v: unknown): string {
  if (v == null) return "0.00";
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a Date as "DD-MM-YYYY" (matches the reference PDFs). */
export function formatDate(d: Date | null | undefined): string {
  if (!d) return "";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  return `${day}-${mon}-${year}`;
}
