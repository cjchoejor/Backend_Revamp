/**
 * One-off repair (2026-08-18): post the missing service-charge + GST companion lines for
 * night-audit ROOM_CHARGE lines written BEFORE the audit started posting them itself.
 *
 * Why: the per-room ROOM_CHARGE the night audit posts is the NET per-night figure, and until
 * 2026-08-18 nothing posted its SC/GST — so every in-stay folio under-billed the rooms by tax
 * while the quotation, the S8 final invoice and the guest emails carried it (the S8/S9 "price
 * is different" report). The audit now writes the two companions itself; this script brings
 * the folios audited before that up to the same ledger shape.
 *
 * What it does, per affected (folio, night-audit run):
 *   - finds ROOM_CHARGE lines with a `nightAuditRecordId` whose run has NO SERVICE/GST
 *     companion on that folio,
 *   - posts `Service charge (…) on: <room line description>` and `GST (…) on: …` at the
 *     configured rates (compound GST on net + SC), honouring the assignment's own
 *     serviceChargeApplies / gstApplies / isFoc flags, stamped with the same
 *     nightAuditRecordId + roomId + chargeDate + billingModel as the room line,
 *   - recomputes `Folio.outstandingBalance`.
 *
 * Scope: only folios that are still LIVE or OUTSTANDING on ACTIVE entries. SETTLED / closed
 * folios were closed at the figure the guest actually paid — re-opening them is a business
 * decision, so they are REPORTED, never touched. Imported legacy "Room charge (imported)"
 * rows carry no nightAuditRecordId and are out of scope (the invoice still taxes them at render).
 *
 * Dry-run by default; pass --commit to write. Idempotent: a run that already has companions
 * is skipped, so re-running is safe.
 */
import { FolioLineType, Stage } from "@prisma/client";
import { prisma } from "../src/db.js";
import { resolveChargeRates } from "../src/services/infrastructure/compute-stay-charges.js";
import { recomputeFolioOutstandingBalance } from "../src/lib/folio-outstanding-from-payment.js";
import { classifyFolioLine, gstLineDescription, serviceChargeLineDescription } from "../src/lib/folio-tax-lines.js";
import { mulMoney, round2, toDecimal, ZERO } from "../src/lib/money.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);
console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — rates: service charge ${serviceChargeRate * 100}% · GST ${gstRate * 100}%`);

const roomLines = await prisma.folioLine.findMany({
  where: { lineType: FolioLineType.ROOM_CHARGE, nightAuditRecordId: { not: null } },
  include: { folio: { include: { entry: { select: { id: true, status: true, currentStage: true } } } } },
  orderBy: [{ folioId: "asc" }, { chargeDate: "asc" }],
});

const byFolio = new Map<string, typeof roomLines>();
for (const l of roomLines) byFolio.set(l.folioId, [...(byFolio.get(l.folioId) ?? []), l]);

let postedFolios = 0;
let postedLines = 0;
const skippedSettled: string[] = [];

for (const [folioId, lines] of byFolio) {
  const folio = lines[0].folio;
  const allLines = await prisma.folioLine.findMany({ where: { folioId } });
  const runsWithCompanions = new Set(
    allLines
      .filter((l) => classifyFolioLine(l) !== "CHARGE" && l.nightAuditRecordId)
      .map((l) => l.nightAuditRecordId as string),
  );
  const missing = lines.filter((l) => !runsWithCompanions.has(l.nightAuditRecordId as string) && toDecimal(l.amount).gt(0));
  if (missing.length === 0) continue;

  const inScope =
    folio.entry.status === "ACTIVE" && (folio.state === "LIVE" || folio.state === "OUTSTANDING");
  if (!inScope) {
    skippedSettled.push(`${folioId} (${folio.entry.id} · ${folio.entry.status} · folio ${folio.state}) — ${missing.length} room line(s) without tax`);
    continue;
  }

  // Tax flags per room from the entry's assignments (a room usually has one row; a per-night
  // split has several with identical flags — take the first).
  const assignments = await prisma.roomAssignment.findMany({
    where: { entryId: folio.entryId },
    select: { roomId: true, serviceChargeApplies: true, gstApplies: true, isFoc: true },
  });
  const flagsForRoom = (roomId: string | null) => {
    const a = roomId ? assignments.find((x) => x.roomId === roomId) : undefined;
    if (!a) return { sc: true, gst: true };
    if (a.isFoc) return { sc: false, gst: false };
    return { sc: a.serviceChargeApplies !== false, gst: a.gstApplies !== false };
  };

  console.log(`\n${folioId} · ${folio.entry.id} @${folio.entry.currentStage} · folio ${folio.state} · balance ${folio.outstandingBalance}`);
  const creates: Parameters<typeof prisma.folioLine.create>[0]["data"][] = [];
  for (const l of missing) {
    const net = round2(toDecimal(l.amount));
    const flags = flagsForRoom(l.roomId);
    const sc = flags.sc && serviceChargeRate > 0 ? round2(mulMoney(net, serviceChargeRate)) : ZERO;
    const gst = flags.gst && gstRate > 0 ? round2(mulMoney(net.add(sc), gstRate)) : ZERO;
    console.log(`  ${l.chargeDate.toISOString().slice(0, 10)}  ${l.description}  net ${net}  → SC ${sc} · GST ${gst}`);
    const base = {
      folioId,
      currency: l.currency,
      chargeDate: l.chargeDate,
      stage: Stage.S7,
      postedBy: ACTOR,
      nightAuditRecordId: l.nightAuditRecordId,
      billingModel: l.billingModel,
      roomId: l.roomId,
    };
    if (sc.gt(0)) {
      creates.push({ ...base, lineType: FolioLineType.SERVICE, description: serviceChargeLineDescription(serviceChargeRate, l.description), amount: sc });
    }
    if (gst.gt(0)) {
      creates.push({ ...base, lineType: FolioLineType.OTHER, description: gstLineDescription(gstRate, l.description), amount: gst });
    }
  }
  if (creates.length === 0) continue;
  postedFolios += 1;
  postedLines += creates.length;
  if (COMMIT) {
    await prisma.$transaction(async (tx) => {
      for (const data of creates) await tx.folioLine.create({ data });
      await recomputeFolioOutstandingBalance(tx, folioId);
    });
    const after = await prisma.folio.findUniqueOrThrow({ where: { id: folioId }, select: { outstandingBalance: true } });
    console.log(`  ✔ posted ${creates.length} line(s); balance now ${after.outstandingBalance}`);
  }
}

console.log(`\n${COMMIT ? "Posted" : "Would post"} ${postedLines} companion line(s) across ${postedFolios} folio(s).`);
if (skippedSettled.length) {
  console.log(`\nLeft alone (settled / not active — decide separately):`);
  for (const s of skippedSettled) console.log(`  · ${s}`);
}
if (!COMMIT) console.log(`\nDry run — re-run with --commit to write.`);

await prisma.$disconnect();
