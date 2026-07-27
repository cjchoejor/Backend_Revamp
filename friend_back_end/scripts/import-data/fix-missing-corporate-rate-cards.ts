/**
 * Recovery script — re-read the legacy CSV and create rate cards for any TravelAgent /
 * CorporateAccount that exists in the new DB but is missing its RateCard (a side-effect
 * of the first failed import run, where corporate rate-card allocations collided with
 * Bhutan GBS Tours' existing rate card before the sequence-sync fix was in place).
 *
 * Idempotent: skips parties that already have an active rate card.
 * Dry-run by default; pass --commit to write.
 */
import { PrismaClient, PartyType } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createRateCardVersion } from "../../src/services/admin/rate-card-admin-service.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR_ID = "actor-seed-system";

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === ',') { out.push(cur); cur = ""; } else if (c === '"') inQ = true; else cur += c; }
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
  throw new Error("Could not find agent_rate CSV");
}
function normalizeName(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function toRateOrNull(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s || s.toLowerCase() === "na") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return null;
  return n;
}
function toRequiredRate(raw: string): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n < 0) throw new Error("roomBaseRate invalid: " + raw);
  return n;
}
function toCnbOrNull(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

async function syncSequence(prisma: PrismaClient, prefix: string) {
  const yyyymmdd = (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  })();
  const rows = await prisma.rateCard.findMany({ select: { id: true } });
  const max = rows.reduce((m, r) => {
    const match = r.id.match(new RegExp(`^${prefix}-${yyyymmdd}-(\\d+)$`));
    if (!match) return m;
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  if (max > 0) {
    await prisma.readableIdSequence.upsert({
      where: { prefix_sequenceDate: { prefix, sequenceDate: yyyymmdd } },
      create: { prefix, sequenceDate: yyyymmdd, lastValue: max },
      update: { lastValue: { set: max } },
    });
    console.log(`  Synced ${prefix}/${yyyymmdd} sequence to ${max}`);
  }
}

async function main() {
  const prisma = new PrismaClient();
  console.log(`\n=== Recover missing rate cards (${COMMIT ? "COMMIT" : "DRY RUN"}) ===\n`);

  // Find all parties missing an active rate card.
  const agents = await prisma.travelAgent.findMany({ select: { id: true, displayName: true } });
  const corps  = await prisma.corporateAccount.findMany({ select: { id: true, displayName: true } });

  type Missing = { partyType: PartyType; partyId: string; displayName: string };
  const missing: Missing[] = [];
  for (const a of agents) {
    const active = await prisma.rateCard.findFirst({ where: { partyType: "TRAVEL_AGENT", partyId: a.id, effectiveTo: null } });
    if (!active) missing.push({ partyType: PartyType.TRAVEL_AGENT, partyId: a.id, displayName: a.displayName });
  }
  for (const c of corps) {
    const active = await prisma.rateCard.findFirst({ where: { partyType: "CORPORATE", partyId: c.id, effectiveTo: null } });
    if (!active) missing.push({ partyType: PartyType.CORPORATE, partyId: c.id, displayName: c.displayName });
  }

  console.log(`Parties missing an active rate card: ${missing.length}`);
  for (const m of missing) console.log(`  - [${m.partyType}] ${m.displayName} (${m.partyId})`);
  console.log();

  if (missing.length === 0) {
    console.log("Nothing to fix.");
    await prisma.$disconnect();
    return;
  }

  // Load CSV and index by normalized name → row.
  const csvPath = findCsvPath();
  const lines = readFileSync(csvPath, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const byName = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const name = normalizeName(cells[idx.travel_agent_name] ?? "");
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), cells);
  }

  const planned: { m: Missing; cells: string[] }[] = [];
  const notFound: string[] = [];
  for (const m of missing) {
    const cells = byName.get(m.displayName.toLowerCase());
    if (!cells) notFound.push(m.displayName);
    else planned.push({ m, cells });
  }

  console.log(`Matched to CSV rows: ${planned.length}`);
  if (notFound.length > 0) {
    console.log(`Not found in CSV (skip): ${notFound.length}`);
    for (const n of notFound) console.log(`  - ${n}`);
  }
  console.log();

  if (!COMMIT) {
    console.log("Dry run only. Re-run with --commit to write rate cards.\n");
    await prisma.$disconnect();
    return;
  }

  // Sync RC sequence so allocations don't collide with existing rate cards.
  await syncSequence(prisma, "RC");
  console.log();

  let ok = 0;
  const errors: { name: string; error: string }[] = [];
  for (const { m, cells } of planned) {
    try {
      await createRateCardVersion(prisma, {
        partyType: m.partyType,
        partyId: m.partyId,
        roomBaseRate: toRequiredRate(cells[idx.room_base_rate]),
        extraBedRate: toRateOrNull(cells[idx.extra_bed_rate]) ?? undefined,
        cnbPercent: toCnbOrNull(cells[idx.cnb_percent]) ?? undefined,
        breakfastRate: toRateOrNull(cells[idx.breakfast_rate]) ?? undefined,
        lunchRate: toRateOrNull(cells[idx.lunch_rate]) ?? undefined,
        dinnerRate: toRateOrNull(cells[idx.dinner_rate]) ?? undefined,
        cpRate: toRateOrNull(cells[idx.cp_rate]) ?? undefined,
        mapLunchRate: toRateOrNull(cells[idx.map_lunch_rate]) ?? undefined,
        mapDinnerRate: toRateOrNull(cells[idx.map_dinner_rate]) ?? undefined,
        apRate: toRateOrNull(cells[idx.ap_rate]) ?? undefined,
        currency: "BTN",
        notes: `Recovered import for ${m.displayName} (id from legacy: ${cells[idx.id]})`,
      }, ACTOR_ID);
      ok++;
    } catch (e) {
      errors.push({ name: m.displayName, error: (e as Error).message });
    }
  }

  console.log(`✓ Rate cards created: ${ok}`);
  if (errors.length > 0) {
    console.log(`✗ Errors (${errors.length}):`);
    for (const e of errors) console.log(`  - ${e.name}: ${e.error}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
