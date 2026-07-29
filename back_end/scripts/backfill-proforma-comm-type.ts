/**
 * Relabel proforma-invoice dispatch CommunicationRecords that were written with the wrong
 * commType.
 *
 * `s9-service.dispatchInvoice` used to write `INVOICE_SUPERSEDED_NOTICE` for the PI acknowledgement
 * loop as a temporary dodge around a Windows Prisma-generate issue, even though `PROFORMA_INVOICE`
 * was already in the enum. Those rows are otherwise correct — they just can't be found by type,
 * which the desk's acceptance list relies on.
 *
 * Targets only rows this writer produced: INVOICE_SUPERSEDED_NOTICE at S3 whose payload carries an
 * invoiceId. A genuine superseded-invoice notice would have neither.
 *
 * Dry run by default; pass --commit to write.
 */
import { prisma } from "../src/db.js";

const commit = process.argv.includes("--commit");

const candidates = await prisma.communicationRecord.findMany({
  where: { commType: "INVOICE_SUPERSEDED_NOTICE", stageContext: "S3" },
  select: { id: true, entryId: true, payload: true, contentSummary: true, createdAt: true },
});

const targets = candidates.filter((c) => {
  const p = c.payload as { invoiceId?: unknown } | null;
  return p != null && typeof p === "object" && typeof p.invoiceId === "string";
});

console.log(`INVOICE_SUPERSEDED_NOTICE @ S3: ${candidates.length}`);
console.log(`  of which carry an invoiceId (proforma dispatch loops): ${targets.length}`);
for (const t of targets) {
  console.log(`  ${t.id}  entry=${t.entryId}  "${t.contentSummary}"  ${t.createdAt.toISOString()}`);
}

if (!targets.length) {
  console.log("\nNothing to relabel.");
} else if (!commit) {
  console.log(`\nDry run — pass --commit to relabel ${targets.length} row(s) to PROFORMA_INVOICE.`);
} else {
  const result = await prisma.communicationRecord.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { commType: "PROFORMA_INVOICE" },
  });
  console.log(`\nRelabelled ${result.count} row(s) to PROFORMA_INVOICE.`);
}

await prisma.$disconnect();
