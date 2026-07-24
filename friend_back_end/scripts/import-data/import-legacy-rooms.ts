/**
 * Import the legacy room catalogue (scripts/import-data/legacy-bookings/room.csv) into the new
 * system's RoomType + Room + RatePlanRegistry tables.
 *
 * The legacy-bookings importer only *looks rooms up* by number (it never creates them) — so this
 * script must run first to make the real property's rooms exist before bookings can attach.
 *
 * Behaviour:
 *  - DRY-RUN by default; pass `--commit` to write.
 *  - On --commit it first CLEARS the existing catalogue (RatePlanRegistry, Room, RoomType) so the
 *    demo Deluxe rooms are replaced wholesale. Run `wipe-operational-data.ts --confirm` FIRST so no
 *    operational rows (assignments/holds/etc.) still reference the demo rooms.
 *  - RoomType ids follow the admin convention `<CODE>-<padded-seq>` (e.g. SUIT-0001).
 *  - Rooms are created FREE / AVAILABLE_CLEAN; the bookings importer sets OCCUPIED for live stays.
 *  - One standard RatePlanRegistry row per room type carries the legacy BTN room_rate as baseRate.
 *    msr is derived at 85% of base (a floor; the admin can adjust). The Indian rate column is not
 *    imported (no per-nationality standard-rate surface in the schema — agent/corporate INR rates
 *    live on RateCards instead).
 */
import { PrismaClient, InventoryClaimState, RoomPhysicalState } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";

const COMMIT = process.argv.includes("--commit");
const ACTOR_ID = "actor-seed-system";
const CSV = path.resolve(process.cwd(), "scripts/import-data/legacy-bookings/room.csv");

/** Stable short codes for each legacy room-type name (avoids CODE collisions like EXEC vs EXAP). */
const TYPE_CODE: Record<string, string> = {
  "Family Apartment(King)": "FAMK",
  "Family Apartment(Twin)": "FAMT",
  "Standard Double": "STDD",
  "Standard Single": "STDS",
  "Executive Apartment": "EXAP",
  Executive: "EXEC",
  "Deluxe Double": "DLXD",
  "Deluxe Studio Apartment": "DSAP",
  Suite: "SUIT",
  "Premium Suite": "PRSU",
};

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Row = {};
    header.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

const num = (v: string | undefined) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};
const int = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};

type TypeAgg = {
  name: string;
  code: string;
  maxOccupancy: number;
  maxChildren: number;
  maxExtraBeds: number;
  baseRate: number;
};

async function main() {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  console.log(`Read ${rows.length} room rows from ${path.relative(process.cwd(), CSV)}\n`);

  // Aggregate distinct room types (take the max capacity / extra-bed seen across rooms of the type).
  const types = new Map<string, TypeAgg>();
  for (const r of rows) {
    const name = r.room_type;
    const code = TYPE_CODE[name];
    if (!code) throw new Error(`No short code mapped for room type "${name}" — add it to TYPE_CODE.`);
    const adults = int(r.adult_capacity);
    const children = int(r.children_capacity);
    const extraBeds = int(r.extra_bed_availability);
    const rate = num(r.room_rate);
    const cur = types.get(name);
    if (!cur) {
      types.set(name, { name, code, maxOccupancy: adults + children, maxChildren: children, maxExtraBeds: extraBeds, baseRate: rate });
    } else {
      cur.maxOccupancy = Math.max(cur.maxOccupancy, adults + children);
      cur.maxChildren = Math.max(cur.maxChildren, children);
      cur.maxExtraBeds = Math.max(cur.maxExtraBeds, extraBeds);
      cur.baseRate = Math.max(cur.baseRate, rate); // types are rate-consistent; max is defensive
    }
  }

  console.log(`Room types (${types.size}):`);
  const typeList = [...types.values()].sort((a, b) => a.code.localeCompare(b.code));
  typeList.forEach((t, i) => {
    const id = `${t.code}-${String(i + 1).padStart(4, "0")}`;
    console.log(
      `  ${id.padEnd(10)} ${t.name.padEnd(26)} occ≤${t.maxOccupancy} child≤${t.maxChildren} beds+${t.maxExtraBeds}  rate ${t.baseRate} BTN (msr ${Math.round(t.baseRate * 0.85)})`,
    );
  });
  console.log(`\nRooms (${rows.length}):`);
  for (const r of rows) {
    console.log(`  ${r.room_no.padEnd(6)} ${r.room_type.padEnd(26)} floor ${r.room_no[0]}  ${r.availability_status}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      // Clear the demo catalogue first (operational rows referencing rooms must already be wiped).
      await tx.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
      const delRp = await tx.ratePlanRegistry.deleteMany();
      const delRoom = await tx.room.deleteMany();
      const delType = await tx.roomType.deleteMany();
      console.log(`Cleared: ${delRp.count} rate plans, ${delRoom.count} rooms, ${delType.count} room types.`);

      // Create room types with `<CODE>-<seq>` ids + one standard rate plan each.
      const idByName = new Map<string, string>();
      for (let i = 0; i < typeList.length; i++) {
        const t = typeList[i];
        const id = `${t.code}-${String(i + 1).padStart(4, "0")}`;
        idByName.set(t.name, id);
        await tx.roomType.create({
          data: {
            id,
            code: t.code,
            name: t.name,
            maxOccupancy: t.maxOccupancy,
            maxChildren: t.maxChildren,
            requiredAccompanyingAdults: 1,
            maxExtraBeds: t.maxExtraBeds,
          },
        });
        await tx.ratePlanRegistry.create({
          data: {
            name: `${t.name} Standard`,
            description: `Standard rate for ${t.name} (imported from legacy room.csv)`,
            roomTypeId: id,
            type: "INDIVIDUAL",
            baseRate: t.baseRate as unknown as never,
            currency: "BTN",
            msr: Math.round(t.baseRate * 0.85) as unknown as never,
            createdBy: ACTOR_ID,
          },
        });
      }

      // Create rooms (FREE / clean); the bookings importer will flip live stays to OCCUPIED.
      let roomCount = 0;
      for (const r of rows) {
        const typeId = idByName.get(r.room_type)!;
        await tx.room.create({
          data: {
            roomNumber: r.room_no,
            roomTypeId: typeId,
            floorNumber: int(r.room_no[0]) || null,
            capacity: int(r.adult_capacity) || 2,
            currentClaimState: InventoryClaimState.FREE,
            physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
            isDeficient: false,
            isShadowInventory: false,
          },
        });
        roomCount++;
      }
      await tx.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
      console.log(`Created: ${typeList.length} room types, ${typeList.length} rate plans, ${roomCount} rooms.`);
    });
    console.log(`\nDone.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
