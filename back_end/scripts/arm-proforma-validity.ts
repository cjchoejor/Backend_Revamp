/**
 * Bookings at Set up whose proforma was made before proformas had a time of their own (2026-11-05):
 * each gets the longest its check-in allows, as a new one would, and the quote's clock stops. A proforma
 * whose advance is paid in full gets no clock, since nothing is left for the guest to answer.
 *
 * Dry run by default. `--commit` writes (it needs the queue, so it starts its own pg-boss connection).
 * `--only ENT-…` / `--except ENT-…` name one booking. Re-runnable: a proforma with a time is left alone.
 */
import { prisma } from "../src/db.js";
import { afterProformaMadeTx, stopQuoteValidityTx } from "../src/services/domain/proforma-validity-service.js";
import { evaluateAdvancePaymentCondition } from "../src/services/domain/s3-payment-service.js";
import { resolveStandsUntil } from "../src/lib/quote-validity.js";

const argv = process.argv.slice(2);
const commit = argv.includes("--commit");
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = valueOf("--only");
const except = valueOf("--except");

async function main() {
  const rows = await prisma.invoice.findMany({
    where: {
      invoiceType: "PROFORMA",
      state: { not: "SUPERSEDED" },
      validUntil: null,
      entry: { currentStage: "S3", status: { in: ["ACTIVE", "PARKED"] } },
      ...(only ? { entryId: only } : except ? { entryId: { not: except } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, entryId: true, folioId: true },
  });
  const now = new Date();
  console.log(`${commit ? "COMMIT" : "DRY RUN"}: ${rows.length} proforma(s) at Set up with no time of their own`);
  for (const r of rows) {
    const money = await evaluateAdvancePaymentCondition(prisma, { entryId: r.entryId, folioId: r.folioId });
    const paid = money.requiredAmount > 0 && money.paidInFull;
    const { validUntil } = await resolveStandsUntil(prisma, r.entryId, {}, now, "proforma");
    console.log(`  ${r.entryId} ${r.id} ${paid ? "advance paid: the quote's clock stops, no clock of its own" : `valid until ${validUntil.toISOString()}`}`);
    if (!commit) continue;
    await prisma.$transaction(async (tx) => {
      if (paid) await stopQuoteValidityTx(tx, { entryId: r.entryId, actorId: "SYSTEM", now });
      else await afterProformaMadeTx(tx, { invoiceId: r.id, entryId: r.entryId, actorId: "SYSTEM", now });
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
