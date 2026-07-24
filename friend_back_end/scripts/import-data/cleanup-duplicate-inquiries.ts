/**
 * Cleanup duplicate inquiries created by partial failed runs of the legacy import.
 * Keeps the LATEST (highest serial) inquiry per original reservation_ref_no, deletes the older
 * ones plus their dependent Entry/Segment rows. FK cascades take care of children.
 *
 * Dry-run by default; pass --commit to delete.
 */
import { PrismaClient } from "@prisma/client";

const COMMIT = process.argv.includes("--commit");

(async () => {
  const p = new PrismaClient();
  const inquiries = await p.inquiry.findMany({ select: { id: true, notes: true, createdAt: true } });
  const byRef = new Map<string, { id: string; createdAt: Date }[]>();
  for (const inq of inquiries) {
    const m = (inq.notes ?? "").match(/Original reservation_ref_no: (RES_[\d_]+)/);
    if (!m) continue;
    const ref = m[1];
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref)!.push({ id: inq.id, createdAt: inq.createdAt });
  }

  const toDelete: string[] = [];
  for (const [ref, rows] of byRef) {
    if (rows.length <= 1) continue;
    // Keep the LATEST inquiry (highest readable-ID serial). The older ones are from partial runs.
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const keep = rows[rows.length - 1].id;
    const drop = rows.slice(0, -1).map((r) => r.id);
    console.log(`${ref}: keep ${keep}, drop ${drop.join(", ")}`);
    toDelete.push(...drop);
  }

  console.log(`\nTotal to delete: ${toDelete.length}`);

  if (!COMMIT) {
    console.log("Dry run only. Re-run with --commit to delete.");
    await p.$disconnect();
    return;
  }

  // Delete entries first (cascades segments + everything tied to entry).
  for (const inqId of toDelete) {
    const entries = await p.entry.findMany({ where: { inquiryId: inqId }, select: { id: true } });
    for (const e of entries) {
      // segments + folios + room_assignments etc. cascade via onDelete: Cascade or similar.
      // For safety, explicitly delete known dependents that may NOT cascade.
      await p.segment.deleteMany({ where: { entryId: e.id } });
      await p.folio.deleteMany({ where: { entryId: e.id } });
      await p.roomAssignment.deleteMany({ where: { entryId: e.id } });
      await p.handoffRecord.deleteMany({ where: { entryId: e.id } });
      await p.reservation.deleteMany({ where: { entryId: e.id } });
      await p.entry.delete({ where: { id: e.id } });
    }
    await p.inquiry.delete({ where: { id: inqId } });
  }

  console.log(`✓ Deleted ${toDelete.length} duplicate inquiries (and their entries).`);
  await p.$disconnect();
})();
