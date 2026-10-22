/**
 * Arm the Inquiry clock on bookings that sit at Inquiry without one (2026-10-22).
 *
 * Until today a booking sent back from Negotiation to Inquiry ran no clock at all — the move to
 * Negotiation cancelled the inquiry window and the way back never re-armed it. New re-entries
 * arm it (lib/inquiry-expiry.ts); this finds the ones made before the fix.
 *
 * Picks ACTIVE bookings at S1 with no SCHEDULED ENTRY_EXPIRY clock of any kind, and skips those
 * that have been to Set up (a folio or a reservation) — they get no clock by design.
 * PARKED bookings are left alone: their park follow-up is their clock.
 *
 *   npx tsx scripts/arm-missing-inquiry-clocks.ts                 # dry run — lists them
 *   npx tsx scripts/arm-missing-inquiry-clocks.ts --commit        # arms a fresh window on each
 *   npx tsx scripts/arm-missing-inquiry-clocks.ts --only ENT-… --commit
 */
import { prisma } from "../src/db.js";
import { armInquiryExpiryTx, hasBeenToSetup, resolveInquiryTtlSeconds } from "../src/lib/inquiry-expiry.js";
import { getTimerEngine } from "../src/services/infrastructure/timer-management-service.js";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;

async function main() {
  const candidates = await prisma.entry.findMany({
    where: { currentStage: "S1", status: "ACTIVE", ...(only ? { id: only } : {}) },
    select: { id: true, guestProfile: { select: { firstName: true, lastName: true } }, updatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  const ttl = await resolveInquiryTtlSeconds(prisma as any);
  const missing: typeof candidates = [];
  for (const e of candidates) {
    const live = await prisma.timerRecord.count({ where: { entryId: e.id, timerType: "ENTRY_EXPIRY", status: "SCHEDULED" } });
    if (live > 0) continue;
    if (await hasBeenToSetup(prisma as any, e.id)) {
      console.log(`  skip ${e.id} — has been to Set up, no clock by design`);
      continue;
    }
    missing.push(e);
  }
  console.log(`=== ${missing.length} booking(s) at Inquiry with no clock (window ${Math.round(ttl / 60)} min) ===`);
  for (const e of missing) console.log(`  ${e.id}  ${[e.guestProfile?.firstName, e.guestProfile?.lastName].filter(Boolean).join(" ") || "(no guest yet)"}`);
  if (!commit) {
    console.log("\n(dry run — pass --commit to arm)");
    return;
  }
  const engine = await getTimerEngine();
  for (const e of missing) {
    const armed = await prisma.$transaction((tx) => armInquiryExpiryTx(tx, engine, { entryId: e.id, actorId: "SYSTEM" }));
    console.log(`  armed ${e.id} → lapses ${armed?.firesAt.toISOString() ?? "(not armed)"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
