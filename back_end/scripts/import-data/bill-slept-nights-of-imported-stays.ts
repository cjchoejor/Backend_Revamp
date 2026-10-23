/**
 * Bill the nights already slept by guests who were in the hotel when the old system's bookings
 * came across (2026-10-23, the go-live).
 *
 * `import-upcoming-from-old-system.ts` brings an in-house guest across with the WHOLE stay, from
 * the real arrival, but charges nothing — this system bills a night by running its night audit
 * for it. The hotel-wide audit only ever runs for the night just ended, so the earlier nights of
 * those stays would never be billed. This runs the per-booking night audit
 * (`runNightAuditForEntry`, the same call the desk's "Post it" makes) for every slept night of
 * every imported in-house stay: the same room line and service-charge / GST companions, one per
 * room per night, from the figures frozen at import.
 *
 * Safe to repeat: a night already posted for a booking posts nothing a second time. It never
 * touches tonight — the hotel's own run bills that tomorrow morning.
 *
 *   npx tsx scripts/import-data/bill-slept-nights-of-imported-stays.ts            # dry run — lists the nights
 *   npx tsx scripts/import-data/bill-slept-nights-of-imported-stays.ts --commit   # posts them
 */
import { PrismaClient } from "@prisma/client";
import { runNightAuditForEntry } from "../../src/services/application/s7-night-audit-service.js";
import { hotelTodayUtc } from "../../src/lib/stay-dates.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR_ID = "actor-seed-system";
const IMPORT_TAG = "Imported from the old PMS";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const prisma = new PrismaClient();
  try {
    const today = hotelTodayUtc();
    console.log(`\n=== Nights already slept by imported in-house guests (${COMMIT ? "COMMIT" : "DRY RUN"}) ===`);
    console.log(`today at the hotel: ${ymd(today)} — nights up to and including ${ymd(new Date(today.getTime() - 86_400_000))} are billed here\n`);

    const stays = await prisma.entry.findMany({
      where: { currentStage: "S7", status: "ACTIVE", inquiry: { notes: { contains: IMPORT_TAG } } },
      select: {
        id: true, checkInDate: true, checkOutDate: true,
        guestProfile: { select: { firstName: true, lastName: true } },
        folio: { select: { id: true, outstandingBalance: true } },
      },
      orderBy: { checkInDate: "asc" },
    });

    let nights = 0, posted = 0;
    for (const s of stays) {
      if (!s.checkInDate || !s.checkOutDate) continue;
      const guest = [s.guestProfile?.firstName, s.guestProfile?.lastName].filter(Boolean).join(" ");
      const slept: string[] = [];
      for (let d = new Date(s.checkInDate); d < today && d < s.checkOutDate; d = new Date(d.getTime() + 86_400_000)) slept.push(ymd(d));
      console.log(`${s.id} · ${guest} · ${ymd(s.checkInDate)} → ${ymd(s.checkOutDate)} · ${slept.length} night(s) slept`);
      nights += slept.length;
      if (!COMMIT) continue;
      for (const night of slept) {
        const r = await runNightAuditForEntry(prisma, ACTOR_ID, { operatingDate: night, entryId: s.id });
        posted += r.posted;
      }
      const folio = s.folio ? await prisma.folio.findUnique({ where: { id: s.folio.id }, select: { outstandingBalance: true } }) : null;
      console.log(`    folio balance now ${folio?.outstandingBalance?.toFixed(2) ?? "—"}`);
    }

    console.log(`\n${stays.length} in-house stay(s) · ${nights} night(s) slept`);
    if (COMMIT) console.log(`✓ ${posted} folio line(s) posted (room, meal plan, service charge, GST)`);
    else console.log(`Dry run — nothing posted. Re-run with --commit.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
