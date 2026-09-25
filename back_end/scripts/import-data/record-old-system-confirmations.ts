/**
 * Record, on each imported booking, that its confirmation was sent and answered in the OLD PMS.
 *
 * WHY THIS EXISTS
 * ---------------
 * `import-upcoming-from-old-system.ts` deliberately sends nothing to guests: they already hold a
 * confirmation from the old system, and mailing them a second one from this system would
 * confuse them. But this system reads an ABSENT confirmation as an unanswered one, and two
 * things follow from that:
 *
 *   - the move to Arrival is refused — the W4 activation skips with `VOUCHER_ANSWER_MISSING`
 *     unless the newest DISPATCHED `CONFIRMATION_VOUCHER` carries an answer, and a booking with
 *     no voucher at all fails that test the same way one that was ignored does;
 *   - the Today list shows all 356 of them as "voucher not sent", which buries the real work.
 *
 * So this writes down what actually happened, rather than pretending this system did it: one
 * `CommunicationRecord` per booking, DISPATCHED and answered, whose summary and trace name the
 * OLD reference the confirmation went out under. Read later, the trail says "confirmed over
 * there, on <date>, under RES_…" — never "we emailed this guest".
 *
 * Deliberately narrow:
 *   - only bookings this importer created (the `old reference:` note on their enquiry);
 *   - only those with NO confirmation voucher of their own — a booking confirmed here keeps its
 *     own record and its own answer, and is skipped;
 *   - no W22 acknowledgement window is opened, because nothing is being waited for.
 *
 * USAGE
 *   npx tsx scripts/import-data/record-old-system-confirmations.ts            # dry run
 *   npx tsx scripts/import-data/record-old-system-confirmations.ts --commit
 */
import { PrismaClient, Stage } from "@prisma/client";
import { allocateReadableId } from "../../src/lib/readable-id.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR_ID = "actor-seed-system";
const IMPORT_TAG = "Imported from the old PMS";

async function main() {
  const prisma = new PrismaClient();
  console.log(`\n=== Confirmations from the old system (${COMMIT ? "COMMIT" : "DRY RUN"}) ===\n`);

  const entries = await prisma.entry.findMany({
    where: {
      status: "ACTIVE",
      inquiry: { notes: { contains: IMPORT_TAG } },
    },
    select: {
      id: true, currentStage: true, checkInDate: true,
      inquiry: { select: { notes: true } },
      reservation: { select: { confirmedAt: true } },
      guestProfile: { select: { firstName: true, lastName: true } },
    },
    orderBy: { checkInDate: "asc" },
  });

  // A booking that already carries a voucher of its own is left alone, whatever state it is in:
  // its own record is the true one and this script must never write a second.
  const haveVoucher = new Set(
    (await prisma.communicationRecord.groupBy({
      by: ["entryId"],
      where: { commType: "CONFIRMATION_VOUCHER", entryId: { in: entries.map((e) => e.id) } },
    })).map((r) => r.entryId).filter((id): id is string => !!id),
  );

  const todo = entries.filter((e) => !haveVoucher.has(e.id));
  console.log(`imported bookings still live: ${entries.length}`);
  console.log(`  already carry a confirmation voucher: ${entries.length - todo.length} (left alone)`);
  console.log(`  to record: ${todo.length}\n`);

  for (const e of todo.slice(0, 5)) {
    const ref = /old reference: (\S+)/.exec(e.inquiry?.notes ?? "")?.[1] ?? "—";
    console.log(`  ${e.id} ${e.currentStage} · ${e.guestProfile.firstName} ${e.guestProfile.lastName} · ${ref}`);
  }
  if (todo.length > 5) console.log(`  …and ${todo.length - 5} more`);

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit.\n`);
    await prisma.$disconnect();
    return;
  }

  let written = 0, failed = 0;
  for (const e of todo) {
    const ref = /old reference: (\S+)/.exec(e.inquiry?.notes ?? "")?.[1] ?? null;
    // The moment the booking was confirmed here, which the import set to its old reservation
    // date — so the record sits where the confirmation actually belongs in the history.
    const at = e.reservation?.confirmedAt ?? new Date();
    const summary = ref
      ? `Confirmation sent and answered in the old PMS (reference ${ref}) — recorded when the booking was brought across`
      : `Confirmation sent and answered in the old PMS — recorded when the booking was brought across`;
    try {
      await prisma.$transaction(async (tx) => {
        const id = await allocateReadableId(tx, "COMMUNICATION", at);
        await tx.communicationRecord.create({
          data: {
            id, entryId: e.id, channel: "EMAIL", commType: "CONFIRMATION_VOUCHER",
            stageContext: Stage.S4, direction: "OUTBOUND",
            sendStatus: "DISPATCHED",
            acknowledgementStatus: "RECEIVED", acknowledgementReceivedAt: at,
            contentSummary: summary,
            actorId: ACTOR_ID, createdBy: ACTOR_ID, createdAt: at,
            payload: { recordedBy: "import", system: "old PMS", oldReference: ref },
          },
        });
        await tx.traceEvent.create({
          data: {
            eventType: "CONFIRMATION_VOUCHER.ACKNOWLEDGEMENT_RECORDED",
            actorId: ACTOR_ID, entityType: "CommunicationRecord", entityId: id,
            operation: "CREATE", entryId: e.id, stageContext: Stage.S4, timestamp: at,
            payload: {
              communicationRecordId: id, commType: "CONFIRMATION_VOUCHER",
              acknowledgementMethod: "WRITTEN",
              verbatimNote: summary,
              receivedAt: at.toISOString(),
              recordedBy: "import", oldReference: ref,
            },
          },
        });
      });
      written++;
      if (written % 50 === 0) console.log(`  …${written} recorded`);
    } catch (err) {
      failed++;
      console.log(`  ! ${e.id}: ${(err as Error).message}`);
    }
  }

  console.log(`\nrecorded: ${written}${failed ? ` · failed: ${failed}` : ""}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exit(1); });
