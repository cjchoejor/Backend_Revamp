/**
 * A bill marked sealed when only one payer's share was settled (2026-11-26).
 *
 * Settlement stamped `Folio.closedAt` on every settlement, a payer's share included, so a booking
 * at Check-out whose agency's voucher was settled while the guest still owed read its master bill
 * as "frozen when the bill was settled". The bill is sealed when the guest leaves — settlement now
 * stamps it only then. This clears the stamp on a booking still at Check-out whose guest has not
 * left (a room not released), so its master bill reads as it stands again. The next settlement
 * that lets the guest go stamps it afresh.
 *
 *   npx tsx scripts/unseal-partly-settled-bills.ts            # dry run
 *   npx tsx scripts/unseal-partly-settled-bills.ts --commit
 *   npx tsx scripts/unseal-partly-settled-bills.ts --only ENT-… --commit
 */
import { prisma } from "../src/db.js";
import { readRoomsReleasedByBooking } from "../src/lib/rooms-released-by-booking.js";

const commit = process.argv.includes("--commit");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : null;

async function main() {
  const folios = await prisma.folio.findMany({
    where: {
      closedAt: { not: null },
      state: { in: ["OUTSTANDING", "SETTLED"] },
      entry: { status: "ACTIVE", currentStage: "S8", ...(only ? { id: only } : {}) },
    },
    select: { id: true, entryId: true, state: true, closedAt: true, outstandingBalance: true },
  });
  let n = 0;
  for (const f of folios) {
    const released = await readRoomsReleasedByBooking(prisma, f.entryId);
    if (released.allReleased) continue;
    n++;
    const still = released.rooms.filter((r) => !r.released).map((r) => r.roomNumber).join(", ");
    console.log(`${f.entryId} · ${f.id} · ${f.state} · owes ${f.outstandingBalance} · marked closed ${f.closedAt?.toISOString()} · guest still in Room ${still}`);
    if (commit) {
      await prisma.$transaction(async (tx) => {
        await tx.folio.update({ where: { id: f.id }, data: { closedAt: null, closedBy: null } });
        await tx.traceEvent.create({
          data: {
            eventType: "FOLIO.SEAL_STAMP_CLEARED",
            actorId: "SYSTEM",
            actorLevel: "L4",
            entityType: "Folio",
            entityId: f.id,
            operation: "UPDATE",
            timestamp: new Date(),
            stageContext: "S8",
            entryId: f.entryId,
            payload: { closedAtWas: f.closedAt?.toISOString() ?? null, why: "a payer's share was settled; the guest has not left", script: "unseal-partly-settled-bills" },
            createdBy: "SYSTEM",
          },
        });
      });
    }
  }
  console.log(`${n} bill(s) ${commit ? "put back to not sealed" : "to put back (dry run — pass --commit)"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
