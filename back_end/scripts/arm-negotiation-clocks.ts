/**
 * Arm the Negotiation clock on bookings that were ALREADY sitting at Negotiation when the clock
 * was added (2026-09-29).
 *
 * The clock is armed on the forward move into Negotiation (`progressS1ToS2`), so a booking that
 * crossed before the change has none and would sit there for ever. This gives each one a clock on
 * the rule `armNegotiationExpiryTx` applies everywhere else: a booking that has been to Set up (it
 * has a folio or a reservation — it may hold money) is skipped, a live quote of this pass sets the
 * moment, and otherwise it runs as long as a quote could stand.
 *
 * `--rebase` also moves a clock armed before 2026-11-05, which ran on the old 24-hour setting until
 * the booking's next quote, onto that rule. A clock armed since says so on its row (`basis`) and is left.
 *
 * Dry-run by default; `--commit` writes. Re-runnable: a booking with a live clock is never given a
 * second one.
 *
 *   npx tsx scripts/arm-negotiation-clocks.ts            # what it would do
 *   npx tsx scripts/arm-negotiation-clocks.ts --commit   # do it
 *   npx tsx scripts/arm-negotiation-clocks.ts --rebase --commit
 *   npx tsx scripts/arm-negotiation-clocks.ts --commit ENT-20260929-0002   # just this one
 */
import { prisma } from "../src/db.js";
import { getTimerEngine } from "../src/services/infrastructure/timer-management-service.js";
import { armNegotiationExpiryTx, negotiationLapseAt, NEGOTIATION_EXPIRY_CODE } from "../src/lib/negotiation-expiry.js";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const rebase = args.includes("--rebase");
const only = args.filter((a) => !a.startsWith("--"));

async function main() {
  const rows = await prisma.entry.findMany({
    where: {
      currentStage: "S2",
      status: "ACTIVE",
      ...(only.length ? { id: { in: only } } : {}),
    },
    select: {
      id: true,
      folio: { select: { id: true } },
      reservations: { select: { id: true }, take: 1 },
      guestProfile: { select: { firstName: true, lastName: true } },
    },
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) {
    console.log("No ACTIVE booking is at Negotiation — nothing to do.");
    return;
  }

  const engine = await getTimerEngine();
  let armed = 0;
  for (const e of rows) {
    const who = `${e.guestProfile?.firstName ?? ""} ${e.guestProfile?.lastName ?? ""}`.trim() || "(no guest)";
    const live = await prisma.timerRecord.findFirst({
      where: { entryId: e.id, timerType: "ENTRY_EXPIRY", timerCode: NEGOTIATION_EXPIRY_CODE, status: "SCHEDULED" },
      select: { firesAt: true, payload: true },
    });
    if (e.folio || e.reservations.length > 0) {
      console.log(`SKIP  ${e.id} · ${who} — it has been to Set up (a clock never ends a booking that may hold money)`);
      continue;
    }
    const { firesAt, basis } = await negotiationLapseAt(prisma, e.id);
    if (live && !rebase) {
      console.log(`SKIP  ${e.id} · ${who} — a negotiation clock is already running`);
      continue;
    }
    if (live && (live.payload as { basis?: string } | null)?.basis) {
      console.log(`SKIP  ${e.id} · ${who} — its clock is already on the rule (${live.firesAt.toISOString()})`);
      continue;
    }
    if (!commit) {
      console.log(`WOULD ${live ? "MOVE" : "ARM"}  ${e.id} · ${who} — lapses ${firesAt.toISOString()} (${basis === "QUOTE" ? "its quote" : "as long as a quote could stand"})`);
      continue;
    }
    const out = await prisma.$transaction((tx) => armNegotiationExpiryTx(tx, engine, { entryId: e.id, actorId: "SYSTEM" }));
    if (out) {
      armed += 1;
      console.log(`ARMED ${e.id} · ${who} — lapses ${out.firesAt.toISOString()} (${out.basis === "QUOTE" ? "its quote" : "as long as a quote could stand"})`);
    } else {
      console.log(`SKIP  ${e.id} · ${who} — refused by the arming rule`);
    }
  }
  console.log(commit ? `\nDone — ${armed} clock(s) armed.` : `\nDry run — nothing written. Re-run with --commit.`);
}

main()
  .catch((e) => {
    console.error("ERROR", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
