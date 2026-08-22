/**
 * One-off recovery (2026-08-22): ENT-20260821-0001's first stay-extension commit crashed AFTER
 * the irreversible re-entry (an in-place extension had no "target" room in the composite's
 * room map — fixed in room-change-service), leaving the booking at S2 in segment 3 with the
 * entry's checkout already moved to 28 Aug and the assignment row run on. This finishes the
 * walk exactly as the composite would have: sealed config with the extra nights (stayExtension
 * marker), silent quote on the request's compositions (as FOM), S2→S3, hold refreshed in place,
 * re-freeze with the new checkout, voucher answer, compressed S4→S7 return, night-audit clocks,
 * assignment row re-frozen, request COMMITTED. Mirrors steps 2–7 for an S7 origin.
 * Dry-run by default; `--commit` writes.
 */
import { Prisma, Stage } from "@prisma/client";
import { prisma } from "../src/db.js";
import { createQuotation, type RoomCompositionServiceInput } from "../src/services/domain/s2-quotation-service.js";
import { progressS2ToS3 } from "../src/state-machines/s2-s3-state-machine.js";
import { confirmReservation } from "../src/services/domain/s4-confirmation-service.js";
import { recordCommunicationAcknowledgement } from "../src/services/domain/communication-acknowledgement-service.js";
import { registerNightAuditTimers } from "../src/services/domain/pre-arrival-service.js";
import { hydrateRoomAssignmentComposition } from "../src/lib/hydrate-room-assignment-composition.js";
import { cancelEntryTimersByCode } from "../src/lib/cancel-entry-timers-by-code.js";

const ENTRY = "ENT-20260821-0001";
const COMMIT = process.argv.includes("--commit");
const DAY_MS = 86_400_000;
const nightsBetween = (a: Date, b: Date) => {
  const out: string[] = [];
  for (let t = a.getTime(); t < b.getTime(); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

async function main() {
  const fom = await prisma.staffUser.findFirst({ where: { actorLevel: "L2" }, select: { id: true } });
  if (!fom) throw new Error("no L2 staff user");
  const actor = { actorId: fom.id, actorLevel: "L2" as const };

  const entry = await prisma.entry.findUniqueOrThrow({
    where: { id: ENTRY },
    include: {
      segments: { orderBy: { segmentNumber: "desc" } },
      reservation: true,
      roomAssignments: true,
      committedHold: true,
      availabilityConfigs: { where: { sealedAt: { not: null } }, orderBy: { sealedAt: "desc" }, take: 1 },
      stayExtensionRequests: { where: { state: "PAID" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const req = entry.stayExtensionRequests[0];
  const seg = entry.segments[0];
  console.log("stage", entry.currentStage, "segment", seg.segmentNumber, "checkout", entry.checkOutDate?.toISOString().slice(0, 10), "request", req?.id, req?.state);
  if (entry.currentStage !== "S2" || !req) throw new Error("nothing to resume");
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate!;
  const extra = req.extraNights as Array<{ date: string; roomId: string }>;
  const roomId = extra[0].roomId;
  const nights = nightsBetween(checkIn, req.newCheckOutDate);
  const perNight = nights.map((date) => ({ date, roomIds: [{ roomId, isDeficient: false }] }));
  const comps = (req.roomCompositions ?? []) as unknown as RoomCompositionServiceInput[];
  console.log("plan nights", nights.join(","), "comps", comps.map((c) => `${c.roomId.slice(0, 6)}:${c.adultCount}`));
  if (!COMMIT) {
    console.log("dry run — pass --commit to finish the walk");
    return;
  }
  const now = new Date();
  const prior = entry.availabilityConfigs[0];
  // 2. Sealed config on the new segment — per-night shape + the extension marker.
  await prisma.availabilityConfiguration.create({
    data: {
      entryId: ENTRY,
      segmentId: seg.id,
      searchCriteria: {
        ...((prior?.searchCriteria as object) ?? {}),
        checkInDate: checkIn.toISOString(),
        checkOutDate: req.newCheckOutDate.toISOString(),
        stayExtension: { requestId: req.id, newCheckOutDate: req.newCheckOutDate.toISOString(), reason: req.reason },
        recalledFromSegmentNumber: seg.segmentNumber - 1,
      } as Prisma.InputJsonValue,
      resultSet: ((prior?.resultSet as object) ?? {}) as Prisma.InputJsonValue,
      optionSelected: {
        perNight,
        isDeficient: false,
        stayExtension: {
          requestId: req.id,
          priorCheckOutDate: req.priorCheckOutDate.toISOString().slice(0, 10),
          newCheckOutDate: req.newCheckOutDate.toISOString().slice(0, 10),
          extraNights: extra,
        },
      } as Prisma.InputJsonValue,
      sealedAt: now,
      createdBy: actor.actorId,
    },
  });
  console.log("sealed config written");
  // 3. Silent quote.
  const created = await createQuotation(prisma, ENTRY, actor.actorId, {
    notes: `Stay extended to ${req.newCheckOutDate.toISOString().slice(0, 10)} (${req.reason}) — walk resumed after a blocked commit`,
    roomCompositions: comps,
    actorLevel: actor.actorLevel,
  });
  console.log("quote", created.id, String(created.totalAmount));
  const fresh = async () => (await prisma.entry.findUniqueOrThrow({ where: { id: ENTRY }, select: { version: true } })).version;
  // Re-freeze the extended assignment row from the quote.
  const fields = await hydrateRoomAssignmentComposition(prisma, ENTRY, roomId);
  const row = entry.roomAssignments.find((a) => a.roomId === roomId);
  if (fields && row) {
    await prisma.$transaction(async (tx) => {
      await tx.roomNightMealPlan.deleteMany({ where: { roomAssignmentId: row.id } });
      await tx.roomAssignment.update({ where: { id: row.id }, data: fields as Prisma.RoomAssignmentUpdateInput });
    });
    console.log("assignment re-frozen");
  }
  // 4. S2 → S3.
  await progressS2ToS3(prisma, ENTRY, actor.actorId, await fresh());
  console.log("at S3");
  // 5. Hold refreshed in place (S7 style).
  await prisma.committedHold.upsert({
    where: { entryId: ENTRY },
    create: {
      entryId: ENTRY,
      segmentId: seg.id,
      roomId,
      roomTypeId: (await prisma.room.findUniqueOrThrow({ where: { id: roomId }, select: { roomTypeId: true } })).roomTypeId,
      state: "PLACED",
      placedAt: now,
      placedBy: actor.actorId,
      commercialJustification: `Stay extension: ${req.reason}`,
      ttlSeconds: 900,
      expiresAt: new Date(Date.now() + 900_000),
      perNightBreakdown: perNight as Prisma.InputJsonValue,
    },
    update: {
      segmentId: seg.id,
      roomId,
      state: "PLACED",
      placedAt: now,
      placedBy: actor.actorId,
      commercialJustification: `Stay extension: ${req.reason}`,
      ttlSeconds: 900,
      expiresAt: new Date(Date.now() + 900_000),
      perNightBreakdown: perNight as Prisma.InputJsonValue,
    },
  });
  console.log("hold refreshed");
  // 6. Re-freeze.
  await confirmReservation(prisma, ENTRY, actor.actorId, { version: await fresh(), carryHighValueAuthority: true });
  console.log("re-frozen");
  const voucher = await prisma.communicationRecord.findFirst({
    where: { entryId: ENTRY, commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", sendStatus: "DISPATCHED", createdAt: { gte: seg.startedAt } },
    orderBy: { createdAt: "desc" },
  });
  if (voucher && voucher.acknowledgementStatus !== "RECEIVED") {
    await recordCommunicationAcknowledgement(prisma, voucher.id, actor, {
      method: "VERBAL",
      verbatimNote: `Guest asked to extend the stay to ${req.newCheckOutDate.toISOString().slice(0, 10)}: ${req.reason}. The paid interim invoice and the request itself are the guest's answer to the re-issued voucher.`,
    });
    console.log("voucher answer recorded");
  }
  // 7. Compressed S4 → S7 return.
  const jumpNow = new Date();
  await prisma.$transaction(async (tx) => {
    const s4Dwell = await tx.stageDwellRecord.findFirst({ where: { entryId: ENTRY, stage: Stage.S4, exitedAt: null }, orderBy: { enteredAt: "desc" } });
    if (s4Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s4Dwell.id },
        data: { exitedAt: jumpNow, dwellSeconds: Math.max(0, Math.floor((jumpNow.getTime() - s4Dwell.enteredAt.getTime()) / 1000)) },
      });
    }
    await tx.stageDwellRecord.create({ data: { entryId: ENTRY, stage: Stage.S7, enteredAt: jumpNow, lastActiveAt: jumpNow, mode: "ACTIVE" } as never });
    await tx.entry.update({ where: { id: ENTRY }, data: { currentStage: Stage.S7, version: { increment: 1 }, updatedAt: jumpNow } });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.ROOM_CHANGE_COMPRESSED_RETURN_S4_TO_S7",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: ENTRY,
        operation: "TRANSITION",
        timestamp: jumpNow,
        stageContext: Stage.S4,
        inquiryId: entry.inquiryId,
        entryId: ENTRY,
        payload: { entryId: ENTRY, stayExtension: req.id, resumedByScript: true, compressedPer: "SIG-S6 §102 / SIG-S7 §42" },
        createdBy: actor.actorId,
      },
    });
    await tx.stayExtensionRequest.update({
      where: { id: req.id },
      data: { state: "COMMITTED", committedAt: jumpNow, committedBy: actor.actorId, outcome: { resumedByScript: true, quotationId: created.id } as Prisma.InputJsonValue },
    });
  });
  await cancelEntryTimersByCode(prisma, { entryId: ENTRY, timerCodes: ["PRE_ARRIVAL_COUNTDOWN_W4", "STAY_EXTENSION_HOLD_EXPIRY_W40", "CHECKOUT_TIME_W26"], cancelledBy: actor.actorId, cancelledReason: "STAY_EXTENSION_RESUMED" }).catch(() => {});
  await registerNightAuditTimers(prisma, ENTRY, actor.actorId).catch((e) => console.log("night audit timers:", (e as Error).message));
  const after = await prisma.entry.findUniqueOrThrow({ where: { id: ENTRY }, select: { currentStage: true, checkOutDate: true, reservation: { select: { frozenCheckOutDate: true } } } });
  console.log("now at", after.currentStage, "checkout", after.checkOutDate?.toISOString().slice(0, 10), "frozen", after.reservation?.frozenCheckOutDate?.toISOString().slice(0, 10));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect().then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500)));
