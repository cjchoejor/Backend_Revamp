/**
 * One-off recovery (2026-08-21): ENT-20260807-0001 was stranded at S2 (segment 2) when a
 * party-seating repair run as L1 committed its re-entry and then blocked at the silent
 * re-quote — the prior 10% discount had been approved post-hoc (S2.DISCOUNT.APPROVED by an
 * L4) and carried no `discountAuthority` stamp, so the carry fell back to the acting L1. The
 * carry now reads the approval trace (room-change-service); this script finishes the walk
 * the way the composite would have — silent quote on the ORIGINAL compositions (so the booking
 * returns to S5 exactly as it was, seating gap included), S2→S3, hold, re-freeze, voucher
 * answer, pre-arrival activation. Mirrors steps 3–7 of `changeRoomToNewSegment` for an S5
 * origin with no assignment rows. Dry-run by default; `--commit` writes.
 */
import { prisma } from "../src/db.js";
import { readOptionSelected } from "../src/lib/option-selected-reader.js";
import { resolveCompositionBasis } from "../src/lib/party-seating.js";
import { createQuotation, type RoomCompositionServiceInput } from "../src/services/domain/s2-quotation-service.js";
import { progressS2ToS3 } from "../src/state-machines/s2-s3-state-machine.js";
import * as s3HoldService from "../src/services/domain/s3-hold-service.js";
import { confirmReservation } from "../src/services/domain/s4-confirmation-service.js";
import { recordCommunicationAcknowledgement } from "../src/services/domain/communication-acknowledgement-service.js";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";
import { getTimerEngine } from "../src/services/infrastructure/timer-management-service.js";

const ENTRY = "ENT-20260807-0001";
const COMMIT = process.argv.includes("--commit");

async function main() {
  const admin = await prisma.staffUser.findFirst({ where: { actorLevel: "L4" }, select: { id: true } });
  if (!admin) throw new Error("no L4 staff user");
  const actor = { actorId: admin.id, actorLevel: "L4" as const };

  const entry = await prisma.entry.findUniqueOrThrow({
    where: { id: ENTRY },
    include: {
      segments: { orderBy: { segmentNumber: "desc" } },
      quotations: { orderBy: { createdAt: "desc" } },
      reservation: true,
      reservations: { orderBy: { confirmedAt: "desc" }, select: { confirmedAt: true, frozenCommercialTerms: true } },
      availabilityConfigs: { where: { sealedAt: { not: null } }, orderBy: { sealedAt: "desc" }, take: 1 },
      roomAssignments: true,
    },
  });
  console.log("stage", entry.currentStage, "segment", entry.segments[0]?.segmentNumber, "assignments", entry.roomAssignments.length);
  if (entry.currentStage !== "S2") throw new Error(`expected S2, found ${entry.currentStage} — nothing to resume`);

  const basis = resolveCompositionBasis<RoomCompositionServiceInput>(entry);
  const terms = basis.terms ?? {};
  const discount = (terms.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  console.log("basis", basis.source, "rows", basis.compositions?.map((c) => `${c.roomId.slice(0, 6)}:${c.adultCount}`), "discount", JSON.stringify(discount));
  if (!basis.compositions) throw new Error("no compositions to re-quote on");

  const sealed = readOptionSelected(entry.availabilityConfigs[0]?.optionSelected ?? null);
  const nightsPerRoom = new Map<string, number>();
  for (const n of sealed.perNight ?? []) for (const id of n.roomIds) nightsPerRoom.set(id, (nightsPerRoom.get(id) ?? 0) + 1);
  const anchorRoomId = [...nightsPerRoom.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sealed.distinctRoomIds[0];
  console.log("anchor room", anchorRoomId);
  if (!COMMIT) {
    console.log("dry run — pass --commit to finish the walk");
    return;
  }

  const fresh = async () => (await prisma.entry.findUniqueOrThrow({ where: { id: ENTRY }, select: { version: true } })).version;

  // 3. Silent quote — the original compositions, the carried discount, generated as L4 (born approved).
  const created = await createQuotation(prisma, ENTRY, actor.actorId, {
    notes: "Walk resumed after a blocked seating repair (2026-08-21 verification) — original compositions carried",
    roomCompositions: basis.compositions,
    ...(discount ? { requestedDiscount: discount } : {}),
    actorLevel: actor.actorLevel,
  });
  console.log("quote", created.id, String(created.totalAmount));

  // 4. S2 → S3
  await progressS2ToS3(prisma, ENTRY, actor.actorId, await fresh());
  console.log("at S3");

  // 5. Hold on the sealed selection (ROOM_CHANGE trigger: money settled in the prior segment).
  await s3HoldService.placeCommittedHold(prisma, ENTRY, actor, {
    roomId: anchorRoomId,
    commercialJustification: "Walk resumed after a blocked seating repair",
    trigger: "ROOM_CHANGE",
  });
  console.log("hold placed");

  // 6. Re-freeze.
  await confirmReservation(prisma, ENTRY, actor.actorId, { version: await fresh(), carryHighValueAuthority: true });
  console.log("re-frozen");

  const segStart = (await prisma.segment.findFirst({ where: { entryId: ENTRY }, orderBy: { segmentNumber: "desc" } }))?.startedAt;
  const voucher = await prisma.communicationRecord.findFirst({
    where: { entryId: ENTRY, commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", sendStatus: "DISPATCHED", ...(segStart ? { createdAt: { gte: segStart } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  if (voucher && voucher.acknowledgementStatus !== "RECEIVED") {
    await recordCommunicationAcknowledgement(prisma, voucher.id, actor, {
      method: "VERBAL",
      verbatimNote: "Walk resumed after a blocked seating repair — the re-issued voucher restates the same stay.",
    });
    console.log("voucher answer recorded");
  }

  // 7. Back to S5.
  const engine = await getTimerEngine();
  const activation = await runPreArrivalWindowActivationWorker(prisma, engine, { entryId: ENTRY }, { skipTaskReset: true });
  console.log("activation", JSON.stringify(activation));
  const after = await prisma.entry.findUniqueOrThrow({ where: { id: ENTRY }, select: { currentStage: true } });
  console.log("now at", after.currentStage);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
