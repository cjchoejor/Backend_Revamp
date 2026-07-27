/**
 * Import legacy `agent_rate` CSV rows into TravelAgent / CorporateAccount + RateCard.
 *
 * Input: CSV at scripts/import-data/agent_rate (with or without .csv extension).
 * Header: id,travel_agent_name,contact_number,mode_of_contact,
 *         room_base_rate,extra_bed_rate,
 *         breakfast_rate,lunch_rate,dinner_rate,
 *         cp_rate,map_lunch_rate,ap_rate,map_dinner_rate,
 *         cnb_percent
 *
 * Behaviour:
 *  - DRY-RUN by default; pass `--commit` to write.
 *  - Names in CORPORATE_NAMES (below) become CorporateAccount; everything else is TravelAgent.
 *  - Case-insensitive duplicate detection against the live DB AND within the file. Existing
 *    rows are skipped (with a note in the report) so re-running is safe.
 *  - mode_of_contact normalized: contains "whatsapp"/"watsapp"/"whats app" → WHATSAPP;
 *    contains "mail"/"email"/"gmail" → EMAIL; "phone" → PHONE; "person" → IN_PERSON; else OTHER.
 *    Original string is preserved in the party's `notes`.
 *  - contact_number: "NA"/"na"/empty → null; otherwise stored as-is (no format normalization).
 *  - Rates: 0.00 → null for optional fields; required for roomBaseRate (zero/empty fails).
 *  - cnb_percent: kept as int (0-100 valid). 0 means "no CNB discount", not "missing".
 *  - Each successful import creates ONE RateCard alongside the party (active from now).
 */
import { PrismaClient, ContactMode, PartyType } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  createTravelAgent,
} from "../../src/services/admin/travel-agent-admin-service.js";
import {
  createCorporateAccount,
} from "../../src/services/admin/corporate-account-admin-service.js";
import { createRateCardVersion } from "../../src/services/admin/rate-card-admin-service.js";

const COMMIT = process.argv.includes("--commit");

// Names that should be CorporateAccount, not TravelAgent. Case-insensitive match against
// the CSV's `travel_agent_name` column.
const CORPORATE_NAMES = new Set(
  [
    "BPC (Standard Single)",
    "BPC(Standard Double)",
    "BPC(Deluxe Single)",
    "BPC(Deluxe Twin)",
    "BYD Thimphu (Rooms)",
    "BYD (1BHK apartment)",
    "BYD (2BHK apartment)",
    "Home Secretary",
    "Bhutan Agro (CEO)",
  ].map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()),
);

const ACTOR_ID = "actor-seed-system";

/* -------------------------- CSV helpers -------------------------------- */

/** Minimal CSV parser that handles quoted fields with commas inside (e.g. "(+91) 7063815541, 8637862841."). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ""; }
      else if (c === '"') inQuotes = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function findCsvPath(): string {
  const base = path.resolve(process.cwd(), "scripts/import-data");
  for (const name of ["agent_rate", "agent_rate.csv"]) {
    const p = path.join(base, name);
    if (existsSync(p)) return p;
  }
  throw new Error("Could not find scripts/import-data/agent_rate or agent_rate.csv");
}

/* -------------------------- Normalization ------------------------------ */

function normalizeName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normalizeMode(raw: string): ContactMode {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("whatsapp") || s.includes("watsapp") || s.includes("whats app")) return ContactMode.WHATSAPP;
  if (s.includes("mail") || s.includes("email") || s.includes("gmail")) return ContactMode.EMAIL;
  if (s.includes("phone")) return ContactMode.PHONE;
  if (s.includes("person")) return ContactMode.IN_PERSON;
  return ContactMode.OTHER;
}

function normalizeContactNumber(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s.toLowerCase() === "na") return null;
  return s;
}

/** "0.00" / "" / "NA" → null; otherwise parsed positive number. Throws on negative / NaN. */
function toRateOrNull(raw: string, label: string, allowZero = false): number | null {
  const s = (raw ?? "").trim();
  if (!s || s.toLowerCase() === "na") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${label} is not a number: "${raw}"`);
  if (n < 0) throw new Error(`${label} is negative: ${n}`);
  if (n === 0 && !allowZero) return null;
  return n;
}

/** roomBaseRate is required + >= 0. Zero is a valid value (preserved per user direction). */
function toRequiredRate(raw: string): number {
  const s = (raw ?? "").trim();
  if (!s) throw new Error("roomBaseRate is empty");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`roomBaseRate must be a non-negative number, got ${raw}`);
  return n;
}

function toCnbOrNull(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`cnb_percent must be 0-100, got "${raw}"`);
  return n;
}

/* -------------------------- Main ---------------------------------------- */

type RowPlan = {
  csvId: string;
  rawName: string;
  name: string;
  partyType: PartyType;
  contactNumber: string | null;
  modeOfContact: ContactMode;
  originalModeRaw: string;
  rate: {
    roomBaseRate: number;
    extraBedRate: number | null;
    breakfastRate: number | null;
    lunchRate: number | null;
    dinnerRate: number | null;
    cpRate: number | null;
    mapLunchRate: number | null;
    apRate: number | null;
    mapDinnerRate: number | null;
    cnbPercent: number | null;
  };
};

async function main() {
  const prisma = new PrismaClient();
  const csvPath = findCsvPath();
  console.log(`\n=== Legacy agent_rate import (${COMMIT ? "COMMIT" : "DRY RUN"}) ===`);
  console.log(`Reading: ${csvPath}`);

  const lines = readFileSync(csvPath, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = parseCsvLine(lines[0]);
  const expected = [
    "id","travel_agent_name","contact_number","mode_of_contact",
    "room_base_rate","extra_bed_rate","breakfast_rate","lunch_rate","dinner_rate",
    "cp_rate","map_lunch_rate","ap_rate","map_dinner_rate","cnb_percent",
  ];
  for (const col of expected) {
    if (!header.includes(col)) throw new Error(`CSV header missing column: ${col}`);
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const dataLines = lines.slice(1);
  console.log(`Rows: ${dataLines.length}\n`);

  // Pre-load existing party display names for case-insensitive dup check.
  const existingAgents = await prisma.travelAgent.findMany({ select: { displayName: true } });
  const existingCorps = await prisma.corporateAccount.findMany({ select: { displayName: true } });
  const existingNames = new Set(
    [...existingAgents, ...existingCorps].map((r) => r.displayName.toLowerCase().replace(/\s+/g, " ").trim()),
  );

  const plans: RowPlan[] = [];
  const errors: { csvId: string; rawName: string; error: string }[] = [];
  const skippedExisting: string[] = [];
  const skippedInFileDup: string[] = [];
  const seenInFile = new Set<string>();

  for (const line of dataLines) {
    const cells = parseCsvLine(line);
    const csvId = cells[idx.id]?.trim() ?? "";
    const rawName = cells[idx.travel_agent_name] ?? "";
    const name = normalizeName(rawName);
    if (!name) {
      errors.push({ csvId, rawName, error: "empty name" });
      continue;
    }
    const key = name.toLowerCase().replace(/\s+/g, " ").trim();
    if (existingNames.has(key)) { skippedExisting.push(name); continue; }
    if (seenInFile.has(key)) { skippedInFileDup.push(name); continue; }
    seenInFile.add(key);

    try {
      const partyType = CORPORATE_NAMES.has(key) ? PartyType.CORPORATE : PartyType.TRAVEL_AGENT;
      const rate = {
        roomBaseRate: toRequiredRate(cells[idx.room_base_rate]),
        extraBedRate: toRateOrNull(cells[idx.extra_bed_rate], "extra_bed_rate"),
        breakfastRate: toRateOrNull(cells[idx.breakfast_rate], "breakfast_rate"),
        lunchRate: toRateOrNull(cells[idx.lunch_rate], "lunch_rate"),
        dinnerRate: toRateOrNull(cells[idx.dinner_rate], "dinner_rate"),
        cpRate: toRateOrNull(cells[idx.cp_rate], "cp_rate"),
        mapLunchRate: toRateOrNull(cells[idx.map_lunch_rate], "map_lunch_rate"),
        apRate: toRateOrNull(cells[idx.ap_rate], "ap_rate"),
        mapDinnerRate: toRateOrNull(cells[idx.map_dinner_rate], "map_dinner_rate"),
        cnbPercent: toCnbOrNull(cells[idx.cnb_percent]),
      };
      plans.push({
        csvId,
        rawName,
        name,
        partyType,
        contactNumber: normalizeContactNumber(cells[idx.contact_number]),
        modeOfContact: normalizeMode(cells[idx.mode_of_contact]),
        originalModeRaw: (cells[idx.mode_of_contact] ?? "").trim(),
        rate,
      });
    } catch (e) {
      errors.push({ csvId, rawName, error: (e as Error).message });
    }
  }

  /* -------- Report -------- */
  const agentPlans = plans.filter((p) => p.partyType === PartyType.TRAVEL_AGENT);
  const corpPlans = plans.filter((p) => p.partyType === PartyType.CORPORATE);

  console.log(`To create (Travel agents): ${agentPlans.length}`);
  console.log(`To create (Corporate):     ${corpPlans.length}`);
  console.log(`Skipped (already in DB):   ${skippedExisting.length}`);
  console.log(`Skipped (dup in file):     ${skippedInFileDup.length}`);
  console.log(`Validation errors:         ${errors.length}\n`);

  if (skippedExisting.length > 0) {
    console.log("Already in DB (skipped):");
    for (const n of skippedExisting) console.log(`  - ${n}`);
    console.log();
  }
  if (skippedInFileDup.length > 0) {
    console.log("Duplicate WITHIN the import file (kept first, skipped subsequent):");
    for (const n of skippedInFileDup) console.log(`  - ${n}`);
    console.log();
  }
  if (errors.length > 0) {
    console.log("Validation errors:");
    for (const e of errors) console.log(`  - [id=${e.csvId}] "${e.rawName}": ${e.error}`);
    console.log();
  }

  console.log("Corporates planned (verify this matches your list):");
  for (const p of corpPlans) console.log(`  - ${p.name}`);
  console.log();

  if (!COMMIT) {
    console.log("Dry run only. Re-run with --commit to apply.\n");
    await prisma.$disconnect();
    return;
  }

  /* -------- Commit -------- */
  console.log("Writing…\n");

  // Sync each readable-id sequence to be past whatever's already in the DB for today's date
  // — otherwise allocateReadableId can collide with rows that were created before the
  // ReadableIdSequence row existed (e.g., after a wipe).
  const yyyymmdd = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  })();
  const seqPrefix = (rows: { id: string }[], prefix: string) => {
    const max = rows.reduce((m, r) => {
      const match = r.id.match(new RegExp(`^${prefix}-${yyyymmdd}-(\\d+)$`));
      if (!match) return m;
      const n = Number.parseInt(match[1], 10);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    return max;
  };
  for (const [prefix, delegate] of [
    ["TA", prisma.travelAgent],
    ["CORP", prisma.corporateAccount],
    ["RC", prisma.rateCard],
  ] as const) {
    const rows = await (delegate as { findMany: (args: { select: { id: true } }) => Promise<{ id: string }[]> }).findMany({ select: { id: true } });
    const max = seqPrefix(rows, prefix);
    if (max > 0) {
      await prisma.readableIdSequence.upsert({
        where: { prefix_sequenceDate: { prefix, sequenceDate: yyyymmdd } },
        create: { prefix, sequenceDate: yyyymmdd, lastValue: max },
        update: { lastValue: { set: max } },
      });
      console.log(`  Synced ${prefix}/${yyyymmdd} sequence to ${max} (past existing rows)`);
    }
  }
  console.log();

  let okAgents = 0;
  let okCorps = 0;
  let writeErrors: { name: string; error: string }[] = [];

  for (const p of plans) {
    try {
      const notes = `Imported from legacy agent_rate (id=${p.csvId}). Original mode_of_contact: "${p.originalModeRaw}"`;
      let partyId: string;
      if (p.partyType === PartyType.TRAVEL_AGENT) {
        const agent = await createTravelAgent(prisma, {
          displayName: p.name,
          contactNumber: p.contactNumber,
          contactEmail: null,
          modeOfContact: p.modeOfContact,
          notes,
          isActive: true,
        }, ACTOR_ID);
        partyId = agent.id;
        okAgents++;
      } else {
        const corp = await createCorporateAccount(prisma, {
          displayName: p.name,
          contactNumber: p.contactNumber,
          contactEmail: null,
          modeOfContact: p.modeOfContact,
          gstNumber: null,        // backfill later in admin UI
          billingAddress: null,   // backfill later in admin UI
          notes,
          isActive: true,
        }, ACTOR_ID);
        partyId = corp.id;
        okCorps++;
      }

      await createRateCardVersion(prisma, {
        partyType: p.partyType,
        partyId,
        roomBaseRate: p.rate.roomBaseRate,
        extraBedRate: p.rate.extraBedRate ?? undefined,
        cnbPercent: p.rate.cnbPercent ?? undefined,
        breakfastRate: p.rate.breakfastRate ?? undefined,
        lunchRate: p.rate.lunchRate ?? undefined,
        dinnerRate: p.rate.dinnerRate ?? undefined,
        cpRate: p.rate.cpRate ?? undefined,
        mapLunchRate: p.rate.mapLunchRate ?? undefined,
        mapDinnerRate: p.rate.mapDinnerRate ?? undefined,
        apRate: p.rate.apRate ?? undefined,
        currency: "BTN",
        notes: `Imported from legacy agent_rate (id=${p.csvId})`,
      }, ACTOR_ID);
    } catch (e) {
      writeErrors.push({ name: p.name, error: (e as Error).message });
    }
  }

  console.log(`✓ Travel agents created: ${okAgents}`);
  console.log(`✓ Corporates created:    ${okCorps}`);
  if (writeErrors.length > 0) {
    console.log(`\n✗ Write errors (${writeErrors.length}):`);
    for (const e of writeErrors) console.log(`  - ${e.name}: ${e.error}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
