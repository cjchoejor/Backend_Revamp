/**
 * Backfill Room.bedType / Room.bedCount (2026-08-10) from the legacy catalogue
 * (scripts/import-data/legacy-bookings/room.csv — columns `bed_size` + `no_of_beds`), matching
 * rooms by number. Non-destructive: touches only the two bed columns on rooms it finds; rooms
 * absent from the CSV are left alone and reported.
 *
 * Dry-run by default; `--commit` to write. Re-runnable (idempotent overwrite of the same
 * derived values).
 *
 *   npx tsx scripts/import-data/backfill-room-bed-types.ts
 *   npx tsx scripts/import-data/backfill-room-bed-types.ts --commit
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const COMMIT = process.argv.includes("--commit");
const CSV = path.resolve(process.cwd(), "scripts/import-data/legacy-bookings/room.csv");

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

const int = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : 0;
};

/** Same derivation as import-legacy-rooms.ts `bedFromLegacyRow` — keep the two in step. */
function bedFromLegacyRow(r: Row): { bedType: string | null; bedCount: number | null } {
  const size = (r.bed_size ?? "").trim().toUpperCase();
  const count = int(r.no_of_beds) || null;
  let bedType: string | null = null;
  if (size.startsWith("KING")) bedType = "KING";
  else if (size.startsWith("QUEEN")) bedType = "QUEEN";
  else if (size.startsWith("SINGLE")) bedType = (count ?? 1) >= 2 ? "TWIN" : "SINGLE";
  return { bedType, bedCount: count };
}

async function main() {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  console.log(`Read ${rows.length} room rows from ${path.relative(process.cwd(), CSV)}\n`);

  const prisma = new PrismaClient();
  try {
    const dbRooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, bedType: true, bedCount: true } });
    const byNumber = new Map(dbRooms.map((r) => [r.roomNumber, r]));

    const updates: Array<{ id: string; roomNumber: string; bedType: string | null; bedCount: number | null }> = [];
    const missingInDb: string[] = [];
    for (const r of rows) {
      const room = byNumber.get(r.room_no);
      if (!room) {
        missingInDb.push(r.room_no);
        continue;
      }
      const bed = bedFromLegacyRow(r);
      updates.push({ id: room.id, roomNumber: room.roomNumber, ...bed });
      byNumber.delete(r.room_no);
    }

    for (const u of updates) {
      console.log(`  ${u.roomNumber.padEnd(6)} → ${String(u.bedType ?? "—").padEnd(6)} × ${u.bedCount ?? "—"}`);
    }
    if (missingInDb.length) console.log(`\nIn CSV but not in DB (skipped): ${missingInDb.join(", ")}`);
    const untouched = [...byNumber.values()].map((r) => r.roomNumber);
    if (untouched.length) console.log(`In DB but not in CSV (left alone): ${untouched.join(", ")}`);

    if (!COMMIT) {
      console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply.`);
      return;
    }

    for (const u of updates) {
      await prisma.room.update({ where: { id: u.id }, data: { bedType: u.bedType, bedCount: u.bedCount } });
    }
    console.log(`\nUpdated ${updates.length} rooms.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
