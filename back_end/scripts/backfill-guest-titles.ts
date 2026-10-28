/**
 * Give guests made from the caller the caller's title (2026-10-28).
 *
 * A guest named at Wrap up as "The caller" got a guest record made from the caller's name, phone
 * and email — but not the caller's title, and until the same day the guest record had no column
 * for one. The papers print the guest's title now, so those guests read "pema lhaden wangchuk"
 * where the desk took "Ms pema lhaden wangchuk". The title is on the enquiry (`callerTitle`), so
 * it can be put back.
 *
 * Targets only guests the `ENTRY.GUEST_NAMED` trace says were made from the caller (mode CALLER),
 * whose name still matches that enquiry's caller, and who have no title yet. A guest named as
 * "Someone else, new" had a title typed that was never stored anywhere — it cannot be recovered,
 * and the script counts those rather than guessing.
 *
 * Dry run by default; pass --commit to write.
 */
import { prisma } from "../src/db.js";
import * as auditService from "../src/services/infrastructure/audit-service.js";

const commit = process.argv.includes("--commit");
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

const named = await prisma.traceEvent.findMany({
  where: { eventType: "ENTRY.GUEST_NAMED" },
  select: { entryId: true, payload: true, timestamp: true },
  orderBy: { timestamp: "desc" },
});

type Target = { guestId: string; entryId: string; title: string; name: string };
const targets = new Map<string, Target>();
const skipped: string[] = [];
let newWithoutTitle = 0;

for (const t of named) {
  const p = (t.payload ?? {}) as { mode?: string; guestProfileId?: string };
  if (!p.guestProfileId || !t.entryId) continue;
  const guest = await prisma.guestProfile.findUnique({
    where: { id: p.guestProfileId },
    select: { id: true, title: true, firstName: true, lastName: true },
  });
  if (!guest || guest.title) continue;
  if (p.mode === "NEW") {
    newWithoutTitle++;
    continue;
  }
  if (p.mode !== "CALLER" || targets.has(guest.id)) continue;
  const entry = await prisma.entry.findUnique({
    where: { id: t.entryId },
    select: { inquiry: { select: { callerTitle: true, callerFirstName: true, callerLastName: true } } },
  });
  const inq = entry?.inquiry;
  const title = inq?.callerTitle?.trim();
  if (!title) continue;
  if (!same(inq?.callerFirstName, guest.firstName) || !same(inq?.callerLastName, guest.lastName)) {
    skipped.push(`  ${guest.id}  ${guest.firstName} ${guest.lastName} — the caller now reads ${inq?.callerFirstName} ${inq?.callerLastName}`);
    continue;
  }
  targets.set(guest.id, { guestId: guest.id, entryId: t.entryId, title, name: `${guest.firstName} ${guest.lastName}` });
}

console.log(`Guests made from the caller, with no title yet, whose caller had one: ${targets.size}`);
for (const t of targets.values()) console.log(`  ${t.guestId}  ${t.title} ${t.name}  (from ${t.entryId})`);
if (skipped.length) {
  console.log(`\nLeft alone — the name no longer matches the caller (${skipped.length}):`);
  for (const s of skipped) console.log(s);
}
console.log(`\nGuests named as someone new with no title on record (cannot be recovered): ${newWithoutTitle}`);

if (!targets.size) {
  console.log("\nNothing to write.");
} else if (!commit) {
  console.log(`\nDry run — pass --commit to give ${targets.size} guest(s) their title.`);
} else {
  const now = new Date();
  for (const t of targets.values()) {
    await prisma.$transaction(async (tx) => {
      await tx.guestProfile.update({ where: { id: t.guestId }, data: { title: t.title } });
      await auditService.emit(tx as any, { actorId: "actor-seed-system", actorLevel: "L4" }, {
        eventType: "GUEST_PROFILE.TITLE_BACKFILLED",
        entityType: "GuestProfile",
        entityId: t.guestId,
        operation: "UPDATE",
        timestamp: now,
        entryId: t.entryId,
        payload: { title: t.title, from: "CALLER", entryId: t.entryId },
      });
    });
  }
  console.log(`\nGave ${targets.size} guest(s) their title.`);
}

await prisma.$disconnect();
