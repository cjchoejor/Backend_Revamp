/**
 * Data repair: put every room's claim flag (`Room.currentClaimState`) back in line with the
 * bookings that actually hold the room. Dry run by default; `--commit` applies.
 *
 *   npx tsx scripts/repair-stuck-room-states.ts [--commit] [--except ENT-…,ENT-…]
 *
 * The rules live in `src/lib/room-flag-repair.ts` (shared with the in-house test fixture's
 * cleanup): a flag saying OCCUPIED with no guest in the room, held / confirmed with no booking
 * holding the room from today on, or "departed" with nothing behind it is reset to what the
 * room's bookings say; a guest in house whose room does not read OCCUPIED gets OCCUPIED (else
 * check-out is refused). A "needs cleaning" flag a real booking set is housekeeping's and stays.
 *
 * Rewritten 2026-10-12. The 2026-07-25 version reset every non-FREE room that no reservation
 * covered TONIGHT — which would also have wiped "needs cleaning" and the flag of every room
 * confirmed for a future stay.
 *
 * `--except` leaves alone any room whose flag was last set by — or whose guest is — one of the
 * named bookings.
 */
import { prisma } from "../src/db.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../src/lib/room-flag-repair.js";
import { ymdUtc } from "../src/lib/stay-dates.js";

async function main() {
  const commit = process.argv.includes("--commit");
  const at = process.argv.indexOf("--except");
  const except = new Set(at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(",").map((s) => s.trim()) : []);
  const { today, guestsIn, plan, skipped } = await planRoomFlagRepairs(prisma, { except });
  console.log(`Hotel day ${ymdUtc(today)} · ${guestsIn} room(s) with a guest in tonight`);
  console.log(`\n=== ${plan.length} room flag(s) to correct ===`);
  for (const p of plan) console.log(`  ${p.roomNumber}: ${p.from} → ${p.to}   (${p.why})`);
  if (skipped.length) {
    console.log(`\n=== left alone (--except) ===`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (!commit) {
    console.log("\n(dry run — pass --commit to apply)");
    return;
  }
  const n = await applyRoomFlagRepairs(prisma, plan, today);
  console.log(`\n✓ committed: ${n} room flag(s) corrected`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
