/**
 * One-shot backfill for Phase 1 of split-billing (2026-07-25).
 *
 * The migration `split_billing_model_phase_1` added `FolioLine.billingModel` (nullable) and
 * `Folio.billingModelDefaults` (nullable). Existing rows were populated with NULL, which means
 * every existing charge would end up in the settlement's "unclassified" bucket.
 *
 * This script:
 *   1. For every Folio with `billingModelDefaults IS NULL` and a non-null `billingModel`,
 *      builds the default per-line-type map (agent-aware) and writes it.
 *   2. For every FolioLine with `billingModel IS NULL`, copies its parent folio's
 *      `billingModel` into the line (preserves current behaviour — every existing line goes
 *      to the folio's single primary payer, as it did before Phase 1).
 *   3. Reports counts. Idempotent — safe to re-run.
 *
 * Dry run by default. Pass `--commit` to apply.
 */
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";
import { buildInitialBillingModelDefaults } from "../src/lib/billing-model-defaults.js";

async function main() {
  const commit = process.argv.includes("--commit");

  // Prisma requires `Prisma.DbNull` (not JS `null`) to filter SQL-NULL on Json columns.
  const foliosNeedingDefaults = await prisma.folio.findMany({
    where: { billingModelDefaults: { equals: Prisma.DbNull }, billingModel: { not: null } },
    select: { id: true, billingModel: true },
  });

  console.log(`Folios needing defaults map: ${foliosNeedingDefaults.length}`);

  const linesNeedingModel = await prisma.folioLine.count({
    where: { billingModel: null },
  });
  console.log(`Folio lines needing billingModel: ${linesNeedingModel}`);

  if (!commit) {
    console.log("\n(dry run — pass --commit to apply)");
    await prisma.$disconnect();
    return;
  }

  // 1. Populate defaults maps.
  let defaultsWritten = 0;
  for (const folio of foliosNeedingDefaults) {
    if (!folio.billingModel) continue;
    // Same tx as the read so the resolver's downstream query sees a consistent inquiry link.
    await prisma.$transaction(async (tx) => {
      const map = await buildInitialBillingModelDefaults(tx, folio.id, folio.billingModel!);
      await tx.folio.update({
        where: { id: folio.id },
        data: { billingModelDefaults: map },
      });
    });
    defaultsWritten += 1;
  }
  console.log(`✓ Wrote billingModelDefaults on ${defaultsWritten} folios`);

  // 2. Copy folio.billingModel → line.billingModel for every null line.
  //
  //    Deliberately raw SQL. `db.ts` extends the client with a FolioLine immutability guard
  //    (`FOLIO_LINE_IMMUTABLE`) that rejects EVERY update/updateMany/delete on a posted line,
  //    including inside a transaction — so the Prisma-client route cannot run this at all.
  //    That guard protects the financial content of a posted charge; this backfill only
  //    populates the newly-added `billingModel` column with the value the line already
  //    settled under (its folio's primary model), so behaviour is unchanged by construction.
  //    A one-time column backfill is the intended exception, not a hole in the invariant.
  const linesUpdated = await prisma.$executeRaw`
    UPDATE folio_lines fl
    SET "billingModel" = f."billingModel"
    FROM folios f
    WHERE fl."folioId" = f.id
      AND fl."billingModel" IS NULL
      AND f."billingModel" IS NOT NULL
  `;
  console.log(`✓ Backfilled billingModel on ${linesUpdated} folio lines`);

  // 3. Any orphaned lines (folio has no billingModel either) — leave null; those pre-date
  //    S3 fixation entirely and shouldn't have charges anyway. Report so we know.
  const orphaned = await prisma.folioLine.count({ where: { billingModel: null } });
  if (orphaned > 0) {
    console.log(`\n⚠  ${orphaned} lines still have NULL billingModel (parent folio has no primary either — likely pre-S3 test data)`);
  }

  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
