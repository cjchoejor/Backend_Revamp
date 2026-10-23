/**
 * Re-make the confirmation vouchers that were filed under another voucher's file (2026-10-13).
 *
 * Voucher files were named by the ENQUIRY (`<INQ>-v1`), the same for every voucher of a booking
 * and of every stay on its enquiry. The first confirmation wrote the file; every later one found
 * it and adopted it ("orphan adoption"), so a booking re-confirmed after a re-entry, a room move
 * or a stay extension — and a return stay — carried the FIRST voucher's rooms and dates.
 *
 * For each stored file shared by more than one reservation, the earliest-confirmed reservation
 * keeps it (it was rendered from its own figures). Every other one has its pointer cleared and is
 * rendered again from its own reservation, now under its own voucher number (VOU-…). The old
 * file stays on disk (write-once). Each re-make is traced `RESERVATION.CONFIRMATION_VOUCHER_REMADE`
 * with the file it had been pointing at. Vouchers that were EMAILED with the wrong file are listed —
 * those guests received the earlier voucher, and only the desk can send them the right one.
 *
 * DRY-RUN by default; pass --commit to write. `--only ENT-…,ENT-…` limits it to those bookings.
 * `--remake RES-…,RES-…` re-makes those vouchers whatever file they hold (e.g. a voucher rendered
 * before it could name the rooms it confirmed), each under the next free file name.
 */
import { prisma } from "../src/db.js";
import { generateOrLoadConfirmationVoucherPdf } from "../src/services/domain/confirmation-voucher-pdf-service.js";

const COMMIT = process.argv.includes("--commit");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const ONLY = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",").map((x) => x.trim())) : null;
const remakeArg = process.argv[process.argv.indexOf("--remake") + 1];
const REMAKE = process.argv.includes("--remake") && remakeArg ? new Set(remakeArg.split(",").map((x) => x.trim())) : null;
const ACTOR = "SYSTEM_REPAIR";

async function main() {
  const rows = await prisma.reservation.findMany({
    where: { confirmationVoucherStorageKey: { not: null } },
    select: { id: true, entryId: true, confirmedAt: true, confirmationVoucherNumber: true, confirmationVoucherStorageKey: true },
    orderBy: { confirmedAt: "asc" },
  });
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) byKey.set(r.confirmationVoucherStorageKey!, [...(byKey.get(r.confirmationVoucherStorageKey!) ?? []), r]);

  const toRemake = REMAKE
    ? rows.filter((r) => REMAKE.has(r.id)).map((r) => ({ ...r, ownerId: r.id }))
    : [...byKey.values()]
        .filter((g) => g.length > 1)
        .flatMap((g) => g.slice(1).map((r) => ({ ...r, ownerId: g[0]!.id })))
        .filter((r) => !ONLY || ONLY.has(r.entryId));

  // The confirmation email's trace does not name its reservation, so it is matched by time: a
  // voucher emailed between its own confirmation and the booking's next one.
  const sends = await prisma.traceEvent.findMany({
    where: { eventType: { in: ["RESERVATION_CONFIRMATION_EMAIL.SENT", "RESERVATION.CONFIRMATION_VOUCHER_RESENT"] }, entryId: { in: toRemake.map((r) => r.entryId) } },
    select: { entryId: true, createdAt: true, payload: true },
  });
  const emailed = new Set<string>();
  for (const r of toRemake) {
    const next = rows.find((x) => x.entryId === r.entryId && x.confirmedAt > r.confirmedAt)?.confirmedAt ?? null;
    const hit = sends.some(
      (t) =>
        t.entryId === r.entryId &&
        ((t.payload as { reservationId?: string } | null)?.reservationId === r.id ||
          (t.createdAt >= r.confirmedAt && (!next || t.createdAt < next))),
    );
    if (hit) emailed.add(r.id);
  }

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${rows.length} vouchers with a file; ${toRemake.length} filed under another voucher's file.\n`);
  for (const r of toRemake) {
    console.log(
      `  ${r.entryId} · ${r.id} (${r.confirmationVoucherNumber ?? "no number"}) used ${r.ownerId}'s file` +
        (emailed.has(r.id) ? "  ⚠ emailed with that file" : ""),
    );
  }
  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to re-make these.`);
    return;
  }

  let done = 0;
  for (const r of toRemake) {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id: r.id },
        data: {
          confirmationVoucherStorageKey: null,
          confirmationVoucherChecksum: null,
          confirmationVoucherRenderedAt: null,
          confirmationVoucherRenderedBy: null,
          confirmationVoucherInputSnapshot: undefined,
        },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "RESERVATION.CONFIRMATION_VOUCHER_REMADE",
          actorId: ACTOR,
          actorLevel: "SYSTEM",
          entityType: "Reservation",
          entityId: r.id,
          operation: "UPDATE",
          timestamp: now,
          entryId: r.entryId,
          payload: {
            reservationId: r.id,
            voucherNumber: r.confirmationVoucherNumber,
            hadFile: r.confirmationVoucherStorageKey,
            fileBelongedTo: r.ownerId,
            emailedWithThatFile: emailed.has(r.id),
            reason:
              r.ownerId === r.id
                ? "Re-made so the voucher names the rooms its reservation confirmed"
                : "The voucher had been filed under an earlier voucher's file (files were named by the enquiry)",
          },
          createdBy: ACTOR,
        } as never,
      });
    });
    const art = await generateOrLoadConfirmationVoucherPdf(prisma, r.id, ACTOR, { remake: true });
    console.log(`  re-made ${r.id} → ${art.storageKey}`);
    done += 1;
  }
  console.log(`\nRe-made ${done} voucher file(s).`);
}

await main();
await prisma.$disconnect();
// The PDF renderer keeps a browser open; without this the script never exits.
process.exit(0);
