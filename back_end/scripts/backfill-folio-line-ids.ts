/**
 * Rewrite every existing folio-line uuid to its readable child id (2026-09-09).
 *
 *   npx tsx scripts/backfill-folio-line-ids.ts            # dry run — prints what it would do
 *   npx tsx scripts/backfill-folio-line-ids.ts --commit   # apply
 *
 * Per folio, lines are numbered in the order they were POSTED (createdAt, then postedAt, then
 * the old id as a stable tiebreak) so `L01` really is the first charge on that bill. Each
 * folio's `lineSequence` is then set to the count, so the next live post continues the run
 * instead of re-issuing a number.
 *
 * Three things point at a folio-line id and all three are carried:
 *   - `billing_model_transition_records.folioLineId` — a real FK, already ON UPDATE CASCADE,
 *     so Postgres moves it for us.
 *   - `invoice_lines.folioLineId` — a SOFT reference (nullable, no FK), so it is rewritten
 *     here by hand; nothing would complain if it were left dangling.
 *   - `folio_lines.description` on a correction — `Correction for <id>: <reason>`, which
 *     `correctCharge` matches with `startsWith` to find a charge's earlier corrections. Miss
 *     this and "set net to" silently stops seeing them, so the arithmetic would drift.
 *
 * Re-runnable: rows already carrying a readable id are skipped, and their folio's sequence is
 * still reconciled.
 */
import { PrismaClient } from "@prisma/client";
import { formatFolioLineId } from "../src/lib/readable-id.js";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

const READABLE = /-L\d+$/;

async function main() {
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — folio-line readable ids\n`);

  const folios = await prisma.folio.findMany({
    select: { id: true, lineSequence: true },
    orderBy: { createdAt: "asc" },
  });

  let renamed = 0;
  let skipped = 0;
  let descriptionsFixed = 0;
  let invoiceRefsFixed = 0;
  const samples: string[] = [];

  for (const folio of folios) {
    const lines = await prisma.folioLine.findMany({
      where: { folioId: folio.id },
      select: { id: true, description: true, createdAt: true, postedAt: true },
      orderBy: [{ createdAt: "asc" }, { postedAt: "asc" }, { id: "asc" }],
    });
    if (lines.length === 0) continue;

    // old id -> new id, for the reference rewrites below.
    const map = new Map<string, string>();
    lines.forEach((line, i) => {
      const next = formatFolioLineId(folio.id, i + 1);
      if (line.id !== next) map.set(line.id, next);
    });

    for (const line of lines) {
      if (READABLE.test(line.id) && !map.has(line.id)) skipped += 1;
    }

    if (COMMIT) {
      await prisma.$transaction(async (tx) => {
        // Rename in order. A new id is `<folioId>-L<nn>`, which cannot collide with a uuid or
        // with another line of this folio, so no staging pass is needed.
        for (const [oldId, newId] of map) {
          await tx.$executeRaw`UPDATE "folio_lines" SET "id" = ${newId} WHERE "id" = ${oldId}`;
          const refs = await tx.$executeRaw`
            UPDATE "invoice_lines" SET "folioLineId" = ${newId} WHERE "folioLineId" = ${oldId}`;
          invoiceRefsFixed += refs;
        }
        // The correction descriptions of THIS folio, now that every id is known.
        for (const [oldId, newId] of map) {
          const fixed = await tx.$executeRaw`
            UPDATE "folio_lines"
            SET "description" = replace("description", ${`Correction for ${oldId}:`}, ${`Correction for ${newId}:`})
            WHERE "folioId" = ${folio.id} AND "description" LIKE ${`Correction for ${oldId}:%`}`;
          descriptionsFixed += fixed;
        }
        await tx.folio.update({ where: { id: folio.id }, data: { lineSequence: lines.length } });
      });
    } else {
      for (const [oldId, newId] of map) {
        const hits = await prisma.folioLine.count({
          where: { folioId: folio.id, description: { startsWith: `Correction for ${oldId}:` } },
        });
        descriptionsFixed += hits;
        invoiceRefsFixed += await prisma.invoiceLine.count({ where: { folioLineId: oldId } });
      }
    }

    renamed += map.size;
    if (samples.length < 6 && map.size > 0) {
      const [oldId, newId] = [...map][0];
      samples.push(`   ${oldId.slice(0, 12)}… -> ${newId}   (${folio.id}, ${lines.length} lines)`);
    }
  }

  console.log(`folios                     : ${folios.length}`);
  console.log(`lines renamed              : ${renamed}`);
  console.log(`lines already readable     : ${skipped}`);
  console.log(`correction descriptions    : ${descriptionsFixed}`);
  console.log(`invoice_lines soft refs    : ${invoiceRefsFixed}`);
  if (samples.length) console.log(`\nsamples:\n${samples.join("\n")}`);
  if (!COMMIT) console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
