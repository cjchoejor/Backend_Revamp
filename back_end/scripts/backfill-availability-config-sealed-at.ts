/**
 * Backfill `AvailabilityConfiguration.sealedAt` for configurations that carry a room selection.
 *
 * `selectOption` — the only path that records a selection — wrote `optionSelected` but never
 * stamped `sealedAt`, while every consumer looks for BOTH (s2-quotation-service and its p01 gate,
 * s3-hold-service, room-assignment-service, rate-reference-service). Bookings whose rooms were
 * saved from the desk therefore could not be quoted (NO_PREFERRED_CONFIGURATION), could not place
 * a committed hold, and showed no reference rates.
 *
 * The service now stamps it. This repairs the rows written before that fix, using the row's own
 * `createdAt` as the seal time — the configuration has no updatedAt column, and its creation is
 * the closest honest anchor for when the selection was made, rather than stamping "now".
 *
 * Dry run by default; pass --commit to write.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { readOptionSelected } from "../src/lib/option-selected-reader.js";

const commit = process.argv.includes("--commit");

async function main() {
  const rows = await prisma.availabilityConfiguration.findMany({
    where: { sealedAt: null, NOT: { optionSelected: { equals: Prisma.DbNull } } },
    select: { id: true, entryId: true, optionSelected: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Only rows that actually carry rooms — an optionSelected with none is not a seal.
  const repairable = rows.filter((r) => readOptionSelected(r.optionSelected as never).distinctRoomIds.length > 0);
  const empty = rows.length - repairable.length;

  console.log(`configurations with a selection but no sealedAt: ${rows.length}`);
  console.log(`  carrying rooms (repairable): ${repairable.length}`);
  console.log(`  carrying no rooms (skipped): ${empty}`);
  for (const r of repairable.slice(0, 15)) {
    const n = readOptionSelected(r.optionSelected as never).distinctRoomIds.length;
    console.log(`  ${r.entryId} · ${r.id.slice(0, 8)} · ${n} room(s) · seal → ${r.createdAt.toISOString()}`);
  }
  if (repairable.length > 15) console.log(`  … and ${repairable.length - 15} more`);

  if (!commit) {
    console.log("\nDry run — re-run with --commit to apply.");
    return;
  }
  let done = 0;
  for (const r of repairable) {
    await prisma.availabilityConfiguration.update({ where: { id: r.id }, data: { sealedAt: r.createdAt } });
    done++;
  }
  console.log(`\nStamped sealedAt on ${done} configuration(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
