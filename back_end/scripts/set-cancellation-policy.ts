/**
 * Put the hotel's cancellation policy on the setting `cancellation.policyTiers` (2026-11-10, operator:
 * the voucher's "45 days or more, 30 to 44 days, less than 30 days" is the hotel's real policy, "100%"
 * meaning the whole advance paid).
 *
 *   45 days or more before arrival   the advance paid is refunded in full
 *   30 to 44 days before arrival     half the advance paid is kept, the rest refunded
 *   less than 30 days before arrival the advance paid is kept, no refund
 *
 * The flat amounts already on the setting are kept (a walk-out after check-in still reads them), and
 * the policy is switched on. Dry run by default; `--commit` saves it, through the same rule the admin
 * console's page uses, as a new version of the setting.
 *
 * MONEY: a booking that reached Set up before 2026-11-10 keeps no policy of its own and is charged by
 * the setting as it is when cancelled — so once this runs, those bookings follow these lines. The
 * desk's "Cancellation policies" page does the same thing by hand.
 *
 *   npx tsx scripts/set-cancellation-policy.ts            # what would be saved
 *   npx tsx scripts/set-cancellation-policy.ts --commit   # save it
 */
import { prisma } from "../src/db.js";
import { getCancellationCharges, setCancellationCharges } from "../src/services/admin/cancellation-policy-admin-service.js";

const HOTEL_LINES = [
  { minDaysBeforeArrival: 45, basis: "PERCENT_OF_PAID" as const, value: 0 },
  { minDaysBeforeArrival: 30, basis: "PERCENT_OF_PAID" as const, value: 50 },
  { minDaysBeforeArrival: 0, basis: "PERCENT_OF_PAID" as const, value: 100 },
];

async function main() {
  const commit = process.argv.includes("--commit");
  const { value: now, overwritten } = await getCancellationCharges(prisma);
  const cur = (now && typeof now === "object" ? now : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const next = {
    enabled: true,
    sameDayPenaltyAmount: num(cur.sameDayPenaltyAmount) ?? 100,
    preArrivalPenaltyAmount: num(cur.preArrivalPenaltyAmount),
    postCheckInEarlyDeparturePenaltyAmount: num(cur.postCheckInEarlyDeparturePenaltyAmount),
    tiers: HOTEL_LINES,
  };
  console.log("The setting now:", overwritten ? "(a list an old save left; nothing charges from it)" : JSON.stringify(now));
  console.log("Would save:     ", JSON.stringify(next));
  if (!commit) {
    console.log("\nDry run. Add --commit to save it.");
    return;
  }
  await setCancellationCharges(prisma, next, "SYSTEM_SCRIPT", "The hotel's cancellation policy (45 / 30 days), set by scripts/set-cancellation-policy.ts");
  console.log("\nSaved.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
