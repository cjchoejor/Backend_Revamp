/**
 * Fill Inquiry.cameInAs for inquiries made before the column existed (2026-09-18).
 *
 *   npx tsx scripts/backfill-inquiry-came-in-as.ts            # dry run — prints what it would set
 *   npx tsx scripts/backfill-inquiry-came-in-as.ts --commit   # write
 *
 * Reads the old encoding the desks used: the channel, plus the marker appended to the notes for
 * the choices DIRECT cannot carry ("Direct (voice)", "Direct (online)", "Group / MICE"), with a
 * GROUP kind of stay counting as the group marker. A plain DIRECT with no marker cannot say voice
 * or online, so it is left empty and listed rather than guessed. The notes are not touched — the
 * marker text stays where staff may already have read it. Only rows with no value are written, so
 * a second run finds nothing to do.
 */
import { prisma } from "../src/db.js";
import { deriveCameInAs } from "../src/lib/inquiry-came-in-as.js";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const rows = await prisma.inquiry.findMany({
    where: { cameInAs: null },
    select: { id: true, sourceChannel: true, notes: true, entries: { select: { useType: true }, orderBy: { createdAt: "asc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  const tally = new Map<string, number>();
  const plan: Array<{ id: string; value: NonNullable<ReturnType<typeof deriveCameInAs>> }> = [];
  const unknown: string[] = [];
  for (const r of rows) {
    const value = deriveCameInAs({ sourceChannel: r.sourceChannel, notes: r.notes, useType: r.entries[0]?.useType ?? null });
    const key = `${r.sourceChannel} → ${value ?? "(left empty)"}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (value) plan.push({ id: r.id, value });
    else unknown.push(`${r.id} · ${r.sourceChannel}`);
  }
  console.log(`${rows.length} inquiry(ies) without a came-in-as · ${plan.length} to fill · ${unknown.length} left empty`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  for (const u of unknown) console.log(`  ? ${u} — a plain channel with no marker; set it from the desk if known`);

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit.");
    return;
  }
  let written = 0;
  for (const p of plan) {
    const r = await prisma.inquiry.updateMany({ where: { id: p.id, cameInAs: null }, data: { cameInAs: p.value } });
    written += r.count;
  }
  console.log(`\nFilled ${written} inquiry(ies).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
