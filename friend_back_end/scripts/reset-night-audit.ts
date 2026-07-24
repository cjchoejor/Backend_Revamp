/**
 * Dev utility: clear night audit runs and folio lines posted by night audit.
 * Uses a plain PrismaClient (not the app extension that blocks deletes).
 *
 * Usage: npx tsx scripts/reset-night-audit.ts
 */
import { PrismaClient } from "@prisma/client";
import { recomputeFolioOutstandingBalance } from "../src/lib/folio-outstanding-from-payment.js";

const prisma = new PrismaClient();

async function main() {
  const auditLines = await prisma.folioLine.findMany({
    where: { nightAuditRecordId: { not: null } },
    select: { folioId: true },
  });
  const folioIds = [...new Set(auditLines.map((l) => l.folioId))];

  const before = await prisma.nightAuditRecord.count();

  const result = await prisma.$transaction(async (tx) => {
    const anomalies = await tx.nightAuditAnomaly.deleteMany();
    const folioLines = await tx.folioLine.deleteMany({ where: { nightAuditRecordId: { not: null } } });
    const records = await tx.nightAuditRecord.deleteMany();
    for (const folioId of folioIds) {
      await recomputeFolioOutstandingBalance(tx, folioId);
    }
    return { anomalies: anomalies.count, folioLines: folioLines.count, records: records.count };
  });

  console.log(
    JSON.stringify(
      {
        nightAuditRecordsBefore: before,
        deleted: result,
        foliosRebalanced: folioIds.length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
