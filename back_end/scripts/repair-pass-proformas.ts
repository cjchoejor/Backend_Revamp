/**
 * Every pass has a proforma of its own (2026-10-29) — the repair for bookings changed before that.
 *
 * A change made from Reserve onward (a room change, a change of the stay, a re-price, an extension…)
 * made the quotation and the voucher again but left the earlier pass's proforma in force, printing
 * the old stay and price (found on ENT-20261029-0032). Since 2026-10-29 the pass replaces it on
 * reaching Set up. This finds the live bookings past Negotiation whose proforma in force is older
 * than their current pass, and gives each pass its own: the old one superseded and linked (its
 * stored paper kept as it is), a new draft made, held for the desk to send or not. Nothing is sent.
 *
 * An old proforma that was never rendered is NOT rendered now — its pass's figures are gone, and
 * rendering it today would print this pass's figures under the old number. It stays to the
 * labelled reconstruction, as any never-rendered replaced version does.
 *
 *   npx tsx scripts/repair-pass-proformas.ts                 # dry run: list
 *   npx tsx scripts/repair-pass-proformas.ts --commit        # all of them
 *   npx tsx scripts/repair-pass-proformas.ts --commit --only ENT-…
 */
import { prisma } from "../src/db.js";
import { ensureProformaOfThisPassTx } from "../src/services/domain/s3-payment-service.js";
import { recordHeldDocument } from "../src/lib/held-documents.js";
import { retireSupersededReplyWaitsBestEffort } from "../src/lib/reply-waits.js";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const onlyAt = argv.indexOf("--only");
const ONLY = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const ACTOR = { actorId: "SYSTEM", actorLevel: "L4" as const };

async function main() {
  const entries = await prisma.entry.findMany({
    where: {
      status: "ACTIVE",
      currentStage: { in: ["S3", "S4", "S5", "S6", "S7"] },
      folio: { isNot: null },
      ...(ONLY ? { id: ONLY } : {}),
    },
    select: {
      id: true,
      currentStage: true,
      folio: { select: { id: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { segmentNumber: true, startedAt: true } },
    },
    orderBy: { id: "asc" },
  });
  let found = 0;
  for (const e of entries) {
    const pass = e.segments[0];
    if (!pass || !e.folio) continue;
    const live = await prisma.invoice.findMany({
      where: { folioId: e.folio.id, invoiceType: "PROFORMA", state: { not: "SUPERSEDED" } },
      select: { id: true, versionNumber: true, state: true, createdAt: true, pdfStorageKey: true },
    });
    if (live.length === 0 || live.some((i) => i.createdAt >= pass.startedAt)) continue;
    found++;
    console.log(
      `${e.id} · ${e.currentStage} · pass ${pass.segmentNumber} from ${pass.startedAt.toISOString()} · in force: ${live
        .map((i) => `${i.id} v${i.versionNumber} ${i.state}${i.pdfStorageKey ? "" : " (never rendered)"} made ${i.createdAt.toISOString()}`)
        .join(", ")}`,
    );
    if (!COMMIT) continue;
    const made = await prisma.$transaction((tx) =>
      ensureProformaOfThisPassTx(tx, { entryId: e.id, folioId: e.folio!.id, passStartedAt: pass.startedAt, basis: "REPAIR_2026_10_29" }, ACTOR),
    );
    if (!made) continue;
    await recordHeldDocument(prisma, { entryId: e.id, kind: "PROFORMA", documentId: made.newInvoiceId, reason: "NEW_PASS", heldBy: ACTOR.actorId, heldByLevel: ACTOR.actorLevel, stage: "S3" });
    await prisma.traceEvent.create({
      data: {
        eventType: "INVOICE.PROFORMA_MADE_FOR_PASS",
        actorId: ACTOR.actorId,
        actorLevel: ACTOR.actorLevel,
        entityType: "Invoice",
        entityId: made.newInvoiceId,
        operation: "CREATE",
        timestamp: new Date(),
        entryId: e.id,
        payload: { entryId: e.id, newInvoiceId: made.newInvoiceId, versionNumber: made.versionNumber, superseded: made.supersededIds, pass: pass.segmentNumber, cause: "REPAIR_2026_10_29" },
        createdBy: ACTOR.actorId,
      },
    });
    await retireSupersededReplyWaitsBestEffort(prisma, e.id, ACTOR.actorId);
    console.log(`   → ${made.newInvoiceId} v${made.versionNumber} made and held; replaced ${made.supersededIds.join(", ")}`);
  }
  console.log(`\n${found} booking(s) whose proforma in force is from an earlier pass${COMMIT ? "" : "\n(dry run — pass --commit to apply)"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
