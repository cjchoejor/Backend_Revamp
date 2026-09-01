/**
 * Recover contact details stranded by the rate-package merge.
 *
 * `migrate-rate-cards-to-packages.ts` merged each agency's variant rows into one survivor, but
 * its first version updated only the survivor's displayName — so every merged-away row's OWN
 * contact number stayed on the deactivated row and vanished from the agency the desk actually
 * uses. Bhutan INC had three different numbers across (Season) / (Off season) / (premium) and
 * kept one. That is precisely the loss `contactNumbers String[]` exists to prevent.
 *
 * Nothing was destroyed: deactivated rows are kept, not deleted, so the numbers are recoverable.
 * Each merged row's notes record "Merged into <survivorId>", which is a far more reliable link
 * than re-deriving the name grouping.
 *
 * Union, survivor's own numbers first, de-duplicated. An email only fills a survivor that has
 * none — one field cannot union, and overwriting a good address would be worse than the gap.
 *
 * Dry run by default; --commit to write.
 */
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");

/**
 * Union of phone numbers, de-duplicated by DIGITS rather than exact string.
 *
 * "91 7363002410" and "917363002410" are the same number typed differently — matching on the
 * raw string would list one agency's single number twice. Same rule `contact-list.ts` uses to
 * identify a coordinator by phone. The first spelling encountered wins, so the survivor's own
 * formatting is preserved.
 */
function unionNumbers(...lists: Array<readonly string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const v = String(raw).trim();
      if (!v) continue;
      const key = v.replace(/\D/g, "") || v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

async function main() {
  const merged = await prisma.travelAgent.findMany({
    where: { isActive: false, notes: { contains: "Merged into " } },
    select: { id: true, displayName: true, contactNumbers: true, contactEmail: true, notes: true },
  });
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${merged.length} merged-away agent rows\n`);

  const plan = new Map<string, { add: string[]; email: string | null; from: string[] }>();
  for (const m of merged) {
    const survivorId = /Merged into (TA-[\w-]+)/.exec(m.notes ?? "")?.[1];
    if (!survivorId) { console.log(`  ?  ${m.id} — notes name no survivor, skipped`); continue; }
    const e = plan.get(survivorId) ?? { add: [], email: null, from: [] };
    for (const n of m.contactNumbers ?? []) if (n?.trim()) e.add.push(n.trim());
    if (!e.email && m.contactEmail) e.email = m.contactEmail;
    e.from.push(m.displayName);
    plan.set(survivorId, e);
  }

  let changed = 0;
  for (const [survivorId, e] of plan) {
    const s = await prisma.travelAgent.findUnique({
      where: { id: survivorId },
      select: { id: true, displayName: true, contactNumbers: true, contactEmail: true },
    });
    if (!s) { console.log(`  !  survivor ${survivorId} not found`); continue; }
    const union = unionNumbers(s.contactNumbers, e.add);
    const before = new Set((s.contactNumbers ?? []).map((n) => n.replace(/\D/g, "") || n.toLowerCase()));
    const gained = union.filter((n) => !before.has(n.replace(/\D/g, "") || n.toLowerCase()));
    const email = s.contactEmail ?? e.email ?? null;
    const emailGained = !s.contactEmail && !!email;
    if (gained.length === 0 && !emailGained) continue;
    changed++;
    console.log(`  ${s.displayName} (${s.id})`);
    console.log(`     had    : ${JSON.stringify(s.contactNumbers)}`);
    console.log(`     recover: ${JSON.stringify(gained)}  from ${e.from.join(", ")}`);
    if (emailGained) console.log(`     email  : ${email}`);
    if (COMMIT) {
      await prisma.travelAgent.update({ where: { id: s.id }, data: { contactNumbers: union, contactEmail: email } });
    }
  }
  console.log(`\nagencies ${COMMIT ? "updated" : "that would be updated"}: ${changed}`);
  if (!COMMIT) console.log("Dry run — nothing written. Re-run with --commit to apply.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
