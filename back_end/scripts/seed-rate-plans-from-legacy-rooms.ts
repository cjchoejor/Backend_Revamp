/**
 * Seed per-room-type rate plans from the legacy hotel data.
 *
 * WHY
 * ---
 * `rate_plan_registry` had exactly two rows: a universal RACK plan at 1,700 and an INDIVIDUAL
 * plan bound to `roomTypeId = "DLX-0001"` — a room type that does not exist. The orphan can
 * never match, so every one of the 10 room types was being priced from the single 1,700 rack
 * rate regardless of whether it was a Standard Single or a Premium Suite.
 *
 * `scripts/import-data/legacy-bookings/room.csv` is the old system's room table and carries the
 * real per-type tariff. This script reads it and creates one INDIVIDUAL rate plan per room type.
 *
 * WHY `INDIVIDUAL`
 * ---------------
 * `pricing-pipeline-engine.ts` sorts eligible plans by type priority (INDIVIDUAL 1 … RACK 5)
 * and takes the first. `loadEligibleRatePlans` narrows to universal plans + plans bound to the
 * requested room type. So a type-bound INDIVIDUAL plan beats the universal RACK fallback for
 * that type, which is exactly the intent.
 *
 * NOT SET: `msr`. The legacy CSV has no minimum-sell-rate column and inventing a commercial
 * floor is not this script's business. Left null, which the engine treats as a 70%-of-nightly
 * placeholder floor (see the `msr` comment on EligibleRatePlan).
 *
 * ALSO SEEDED: `HouseTariff.extraBedRate`, because every row in the CSV carries the same
 * `extra_rate_per_bed` of 900.00. Meal rates are NOT seeded — the legacy data has no meal
 * tariff anywhere (checked room.csv, reservation_billing.csv, all_room_billing.csv,
 * registration_rooms.csv: the latter records which plans a guest took, never their price).
 *
 * Dry run by default. Pass --commit to write.
 *   npx tsx scripts/seed-rate-plans-from-legacy-rooms.ts
 *   npx tsx scripts/seed-rate-plans-from-legacy-rooms.ts --commit
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");
const CREATED_BY = "legacy-room-csv-import";
const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(HERE, "import-data", "legacy-bookings", "room.csv");

/** Minimal RFC-4180-ish splitter — handles quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * "Family Apartment(King)" and "Family Apartment KING" must compare equal — the legacy system
 * used parenthesised suffixes, ours uses a trailing word. Strip punctuation, collapse spaces,
 * uppercase.
 */
function normalizeTypeName(s: string): string {
  return s
    .replace(/[()]/g, " ")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

async function main() {
  const raw = readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0]!);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`room.csv is missing the '${name}' column`);
    return i;
  };
  const iType = col("room_type");
  const iRate = col("room_rate");
  const iRateIndian = col("room_rate_indian");
  const iExtraBed = col("extra_rate_per_bed");
  const iRoomNo = col("room_no");

  // Group rooms by legacy type and collect the distinct rates seen for each.
  type Group = { legacyName: string; rates: Set<string>; indianRates: Set<string>; rooms: string[] };
  const groups = new Map<string, Group>();
  const extraBedRates = new Set<string>();

  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const legacyName = (f[iType] ?? "").trim();
    if (!legacyName) continue;
    const key = normalizeTypeName(legacyName);
    if (!groups.has(key)) groups.set(key, { legacyName, rates: new Set(), indianRates: new Set(), rooms: [] });
    const g = groups.get(key)!;
    g.rates.add((f[iRate] ?? "").trim());
    g.indianRates.add((f[iRateIndian] ?? "").trim());
    g.rooms.push((f[iRoomNo] ?? "").trim());
    const eb = (f[iExtraBed] ?? "").trim();
    if (eb) extraBedRates.add(eb);
  }

  const roomTypes = await prisma.roomType.findMany({ select: { id: true, code: true, name: true } });
  const byNormalizedName = new Map(roomTypes.map((t) => [normalizeTypeName(t.name), t]));

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — parsed ${lines.length - 1} rooms into ${groups.size} room types\n`);

  const planned: Array<{ name: string; roomTypeId: string; baseRate: string; code: string; rooms: number }> = [];
  const problems: string[] = [];

  for (const [key, g] of [...groups.entries()].sort()) {
    const rt = byNormalizedName.get(key);
    if (!rt) {
      problems.push(`No RoomType matches legacy type "${g.legacyName}" (normalized "${key}") — skipped`);
      continue;
    }
    if (g.rates.size > 1) {
      problems.push(`"${g.legacyName}" has ${g.rates.size} different rates in the CSV: ${[...g.rates].join(", ")} — skipped, needs a human decision`);
      continue;
    }
    const baseRate = [...g.rates][0]!;
    if (!/^\d+(\.\d+)?$/.test(baseRate)) {
      problems.push(`"${g.legacyName}" has an unparseable rate "${baseRate}" — skipped`);
      continue;
    }
    planned.push({
      // Deterministic name so re-running upserts rather than duplicating (`name` is @unique).
      name: `${rt.name} — Standard`,
      roomTypeId: rt.id,
      baseRate,
      code: rt.code,
      rooms: g.rooms.length,
    });
  }

  console.log("Rate plans to create/update (type=INDIVIDUAL, beats the universal RACK plan):");
  for (const p of planned) {
    console.log(`   ${p.code.padEnd(4)} ${p.name.padEnd(38)} base=${p.baseRate.padStart(8)}   (${p.rooms} rooms)`);
  }

  // Indian tier: present in the CSV but NOT seeded. There is no nationality dimension in the
  // pricing engine, and adding these as extra plans would make selection non-deterministic
  // (two INDIVIDUAL plans eligible for the same room type, tie broken arbitrarily).
  console.log(`\nIndian-nationality tier found in the CSV but NOT seeded (no nationality input exists in the pricing engine):`);
  for (const [key, g] of [...groups.entries()].sort()) {
    const rt = byNormalizedName.get(key);
    if (!rt) continue;
    console.log(`   ${rt.code.padEnd(4)} ${rt.name.padEnd(30)} BTN ${[...g.rates][0]}  →  Indian ${[...g.indianRates].join("/")}`);
  }

  const orphans = await prisma.ratePlanRegistry.findMany({
    where: { isActive: true, roomTypeId: { not: null } },
    select: { id: true, name: true, roomTypeId: true, baseRate: true },
  });
  const validTypeIds = new Set(roomTypes.map((t) => t.id));
  const toDeactivate = orphans.filter((p) => p.roomTypeId && !validTypeIds.has(p.roomTypeId));
  console.log(`\nActive plans bound to a NON-EXISTENT room type (will be deactivated, not deleted):`);
  if (toDeactivate.length === 0) console.log("   none");
  for (const p of toDeactivate) console.log(`   "${p.name}" → roomTypeId="${p.roomTypeId}" base=${p.baseRate}`);

  console.log(`\nExtra-bed rate from the CSV: ${[...extraBedRates].join(", ")} ${extraBedRates.size === 1 ? "(uniform — safe to seed onto HouseTariff)" : "(NOT uniform — not seeded)"}`);

  if (problems.length) {
    console.log(`\nProblems:`);
    for (const p of problems) console.log(`   ! ${p}`);
  }

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const p of planned) {
      await tx.ratePlanRegistry.upsert({
        where: { name: p.name },
        create: {
          name: p.name,
          description: `Seeded from legacy room.csv for room type ${p.code}.`,
          roomTypeId: p.roomTypeId,
          type: "INDIVIDUAL",
          baseRate: new Prisma.Decimal(p.baseRate),
          currency: "BTN",
          isActive: true,
          createdBy: CREATED_BY,
        },
        update: {
          roomTypeId: p.roomTypeId,
          type: "INDIVIDUAL",
          baseRate: new Prisma.Decimal(p.baseRate),
          isActive: true,
        },
      });
    }
    for (const p of toDeactivate) {
      await tx.ratePlanRegistry.update({ where: { id: p.id }, data: { isActive: false } });
    }
  });
  console.log(`\nWrote ${planned.length} rate plans; deactivated ${toDeactivate.length} orphan(s).`);

  // Seed the extra-bed rate onto the house tariff only when the legacy value is unambiguous
  // and no tariff has been configured yet — never silently overwrite an operator's numbers.
  if (extraBedRates.size === 1) {
    const existing = await prisma.houseTariff.findFirst({
      where: { OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
      orderBy: { effectiveFrom: "desc" },
    });
    if (existing) {
      console.log(`House tariff already configured (${existing.id}) — left untouched. Edit it via POST /api/admin/house-tariff.`);
    } else {
      const created = await prisma.houseTariff.create({
        data: {
          extraBedRate: new Prisma.Decimal([...extraBedRates][0]!),
          notes: "Extra-bed rate seeded from legacy room.csv (extra_rate_per_bed, uniform across all rooms). Meal rates intentionally left unset — the legacy data contains no meal tariff.",
          createdBy: CREATED_BY,
        },
      });
      console.log(`Created house tariff ${created.id} with extraBedRate=${created.extraBedRate}. Meal rates left NULL.`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
