/**
 * Party-seating diagnostic (2026-08-21): for every ACTIVE booking at S4–S8 (or the ids given),
 * print the server-computed seating status — who has NO room, which plan rooms are EMPTY,
 * composition rows left on a replaced room — exactly as `GET /api/entries/:id/party-seating`
 * reports it. Read-only; the repair is `POST /api/entries/:id/party-seating/repair` (the desk's
 * "Seat everyone" button on the guest-detail table).
 *
 *   npx tsx scripts/check-party-seating.ts            # every live S4–S8 booking
 *   npx tsx scripts/check-party-seating.ts ENT-…      # specific bookings
 *   npx tsx scripts/check-party-seating.ts --all      # include bookings that are fine
 */
import { prisma } from "../src/db.js";
import { buildPartySeatingStatus } from "../src/services/domain/party-seating-service.js";

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all");
  const ids = args.filter((a) => !a.startsWith("--"));
  const entries =
    ids.length > 0
      ? await prisma.entry.findMany({ where: { id: { in: ids } }, select: { id: true } })
      : await prisma.entry.findMany({
          where: { status: "ACTIVE", currentStage: { in: ["S4", "S5", "S6", "S7", "S8"] } },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
  let flagged = 0;
  for (const { id } of entries) {
    const st = await buildPartySeatingStatus(prisma, id);
    if (st.ok && !showAll) continue;
    if (!st.ok) flagged++;
    const rn = (r: { roomNumber: string | null; roomId: string }) => r.roomNumber ?? r.roomId.slice(0, 6);
    console.log(`${st.entryId} @${st.currentStage} · basis ${st.source} · ${st.ok ? "OK" : "NEEDS SEATING"}`);
    if (!st.hasComposition) {
      console.log("   no per-room composition anywhere — nothing to seat (legacy / flat-priced)");
      continue;
    }
    for (const p of st.party) {
      console.log(`   ${p.label.padEnd(18)} → ${p.rooms.length ? p.rooms.map(rn).join(" · ") : "NO ROOM"}`);
    }
    if (st.emptyRooms.length) console.log(`   empty room(s): ${st.emptyRooms.map((r) => `${rn(r)}${r.hasRow ? "" : " (no row)"}`).join(", ")}`);
    if (st.strayRooms.length) console.log(`   rows on replaced room(s): ${st.strayRooms.map(rn).join(", ")}`);
    if (!st.ok) console.log(`   repairable: ${st.repairable ? "yes" : `no — ${st.repairBlockedReason}`}`);
  }
  console.log(`checked ${entries.length} booking(s), ${flagged} need seating`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
