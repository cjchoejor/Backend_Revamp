/**
 * One-off repair for ENT-20260814-0001 (2026-08-14 key-lifecycle verification): the booking
 * was checked in while the transitionData DTO was still stripping issuedKeyRoomIds, so no
 * key stamps were written; the verification run then left test stamps behind. Set the true
 * post-check-in picture — 203 + 501 (arrival-night rooms) issued at check-in, 302 untouched
 * until its move day. Also asserts the DTO now carries issuedKeyRoomIds and that the
 * day-one derivation matches expectations.
 */
import { prisma } from "../src/db.js";
import { progressStageRequestSchema } from "../src/dtos/06-reservations/request-schemas.js";
import { countOutstandingKeys, dayOneRoomIds } from "../src/services/domain/room-key-service.js";

const ENTRY = "ENT-20260814-0001";

async function main() {
  // 1. DTO no longer strips issuedKeyRoomIds.
  const parsed = progressStageRequestSchema.parse({
    targetStage: "S7",
    version: 1,
    transitionData: { keyCount: 2, registrationConfirmed: true, issuedKeyRoomIds: ["a", "b"] },
  });
  console.log("DTO carries issuedKeyRoomIds:", JSON.stringify(parsed.transitionData?.issuedKeyRoomIds));

  const entry = await prisma.entry.findUnique({
    where: { id: ENTRY },
    include: { roomAssignments: { include: { room: true } } },
  });
  if (!entry) throw new Error("entry not found");

  // 2. Day-one derivation on the real plan.
  const dayOne = dayOneRoomIds(entry.roomAssignments, entry.checkInDate);
  const byNumber = new Map(entry.roomAssignments.map((a) => [a.room.roomNumber, a]));
  console.log(
    "day-one rooms:",
    entry.roomAssignments.filter((a) => dayOne.has(a.roomId)).map((a) => a.room.roomNumber).sort().join(","),
  );

  // 3. Repair stamps.
  const issuedAt = entry.keysIssuedAt ?? new Date();
  const issuedBy = entry.keysIssuedBy ?? "staff-admin-1";
  for (const num of ["203", "501"]) {
    const a = byNumber.get(num)!;
    await prisma.roomAssignment.update({
      where: { id: a.id },
      data: { keyIssuedAt: issuedAt, keyIssuedBy: issuedBy, keyReturnedAt: null, keyReturnedBy: null },
    });
  }
  const a302 = byNumber.get("302")!;
  await prisma.roomAssignment.update({
    where: { id: a302.id },
    data: { keyIssuedAt: null, keyIssuedBy: null, keyReturnedAt: null, keyReturnedBy: null },
  });
  // keysIssuedCount was sent as 3 by the verification run; the true day-one count is 2.
  await prisma.entry.update({ where: { id: ENTRY }, data: { keysIssuedCount: 2 } });

  const after = await prisma.roomAssignment.findMany({
    where: { entryId: ENTRY },
    include: { room: true },
    orderBy: { createdAt: "asc" },
  });
  for (const a of after) {
    console.log(`room ${a.room.roomNumber}: issued=${a.keyIssuedAt ? "Y" : "-"} returned=${a.keyReturnedAt ? "Y" : "-"}`);
  }
  console.log("outstanding keys (S8 reconciliation source):", await countOutstandingKeys(prisma, ENTRY));
}

main().finally(() => prisma.$disconnect());
