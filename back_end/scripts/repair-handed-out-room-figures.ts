/**
 * A room handed out with no priced figures (found 2026-11-03).
 *
 * Until that day, Arrival's "Pick another of this type" on a one-room booking handed the room out and
 * left the quotation, the hold and the pick on the room the booking had before. The new room's
 * assignment row therefore froze no figures, so:
 *   - the rooms table showed nobody in the room;
 *   - the night audit billed the flat room rate, leaving out the extra bed and the meals.
 *
 * For each live booking in that state this moves its records to the room it was given (the pick, the
 * hold, the quotation of the pass, the bed plan: the same rewrite a room move makes) and fills in the
 * row's figures from the quotation. Nothing is priced again.
 *
 * It never touches the bill. Nights already posted at the flat rate are listed with what they are
 * short: that is for a person to put right, with the guest in mind. A booking whose new room is also
 * claimed by another booking is listed and left alone, for the same reason.
 *
 * Dry run by default.
 *   npx tsx scripts/repair-handed-out-room-figures.ts [--commit] [--only ENT-…]
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { resolveCompositionBasis } from "../src/lib/party-seating.js";
import { hydrateRoomAssignmentComposition } from "../src/lib/hydrate-room-assignment-composition.js";
import { findRoomBookingConflicts } from "../src/lib/room-booking-conflicts.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../src/lib/room-flag-repair.js";
import { relabelEntryRoomsTx } from "../src/services/domain/quiet-rooms-service.js";
import { applyBedPlanToAssignedRooms } from "../src/services/domain/entry-bed-plan-service.js";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;

async function main() {
  const entries = await prisma.entry.findMany({
    where: {
      ...(only ? { id: only } : {}),
      status: { in: ["ACTIVE", "PARKED"] },
      currentStage: { in: ["S5", "S6", "S7", "S8"] },
      roomAssignments: { some: { frozenSubtotal: null } },
    },
    select: {
      id: true,
      inquiryId: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      guestProfile: { select: { firstName: true, lastName: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      quotations: { select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true } },
      reservation: { select: { frozenCommercialTerms: true, frozenRate: true } },
      roomAssignments: { select: { id: true, roomId: true, frozenSubtotal: true, room: { select: { roomNumber: true, roomTypeId: true } } } },
      folio: { select: { id: true } },
    },
  });
  const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true } });
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const roomNumbers = new Map(rooms.map((r) => [r.id, r.roomNumber]));
  let repaired = 0;
  let left = 0;

  for (const e of entries) {
    const basis = resolveCompositionBasis(e);
    const rows = basis.compositions ?? [];
    if (rows.length === 0) continue; // A booking priced flat: its rate is the flat rate.
    const name = `${e.guestProfile?.firstName ?? ""} ${e.guestProfile?.lastName ?? ""}`.trim();
    const assigned = new Set(e.roomAssignments.map((a) => a.roomId));
    const noRow = e.roomAssignments.filter((a) => a.frozenSubtotal == null && !rows.some((r) => r.roomId === a.roomId));
    const stray = rows.filter((r) => !assigned.has(r.roomId));
    const head = `${e.id} ${e.currentStage} ${name}`;
    if (noRow.length !== 1 || stray.length !== 1) {
      console.log(`LEFT   ${head}: ${noRow.length} room(s) with no figures, ${stray.length} row(s) on a room it does not hold. A person must look.`);
      left++;
      continue;
    }
    const a = noRow[0];
    const from = byId.get(stray[0].roomId);
    const to = byId.get(a.roomId);
    if (!from || !to || from.roomTypeId !== to.roomTypeId) {
      console.log(`LEFT   ${head}: Room ${from?.roomNumber} and Room ${to?.roomNumber} are different room types. A person must look.`);
      left++;
      continue;
    }
    if (e.checkInDate && e.checkOutDate) {
      const clashes = await findRoomBookingConflicts(prisma, { roomIds: [to.id], checkIn: e.checkInDate, checkOut: e.checkOutDate, excludeEntryId: e.id });
      if (clashes.length > 0) {
        const names = [...new Set(clashes.map((c) => c.entryId))].join(", ");
        console.log(`LEFT   ${head}: Room ${to.roomNumber} is also held by ${names}. A person must choose which booking keeps it.`);
        left++;
        continue;
      }
    }
    // What the bill has had at the flat rate, for a person to put right.
    const posted = e.folio
      ? await prisma.folioLine.findMany({ where: { folioId: e.folio.id, lineType: "ROOM_CHARGE", roomId: a.roomId }, select: { amount: true } })
      : [];
    const perRoom = (basis.terms as { compositionTotals?: { perRoom?: Array<{ roomId: string; subtotal?: number; nights?: number }> } } | null)?.compositionTotals?.perRoom ?? [];
    const priced = perRoom.find((r) => r.roomId === stray[0].roomId);
    const pricedNight = priced?.subtotal != null && priced.nights ? priced.subtotal / priced.nights : null;
    const postedNet = posted.reduce((s, l) => s + Number(l.amount), 0);
    const owed = pricedNight != null ? pricedNight * posted.length - postedNet : null;
    console.log(
      `${commit ? "MOVED " : "WOULD "} ${head}: rows, hold and pick from Room ${from.roomNumber} to Room ${to.roomNumber}.` +
        (pricedNight != null ? ` Priced Nu ${pricedNight.toFixed(2)} net a night, before service charge and GST.` : "") +
        (posted.length ? ` ${posted.length} night(s) already billed at Nu ${postedNet.toFixed(2)} net: short Nu ${owed?.toFixed(2) ?? "?"} net. The bill is not changed; a person must post it.` : " Nothing billed yet."),
    );
    if (!commit) continue;
    await prisma.$transaction(async (tx) => {
      await relabelEntryRoomsTx(tx, e.id, new Map([[from.id, to.id]]), {
        actorId: "SYSTEM_REPAIR",
        actorLevel: "L4",
        reason: "The room was handed out at Arrival without its priced figures",
        forEntryId: null,
        roomNumbers,
      });
    });
    const fields = await hydrateRoomAssignmentComposition(prisma, e.id, to.id);
    if (!fields) throw new Error(`${e.id}: no figures found for Room ${to.roomNumber} after the move`);
    await prisma.roomAssignment.update({ where: { id: a.id }, data: fields as Prisma.RoomAssignmentUncheckedUpdateInput });
    await prisma.traceEvent.create({
      data: {
        eventType: "ROOM_ASSIGNMENT.FIGURES_REPAIRED",
        actorId: "SYSTEM_REPAIR",
        actorLevel: "L4",
        entityType: "Entry",
        entityId: e.id,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: e.currentStage,
        inquiryId: e.inquiryId,
        entryId: e.id,
        payload: { roomAssignmentId: a.id, fromRoomNumber: from.roomNumber, toRoomNumber: to.roomNumber, nightsBilledFlat: posted.length, billedNet: postedNet.toFixed(2), shortNet: owed?.toFixed(2) ?? null } as Prisma.InputJsonValue,
      },
    });
    await applyBedPlanToAssignedRooms(e.id, "SYSTEM_REPAIR", prisma);
    const plan = await planRoomFlagRepairs(prisma, { roomIds: [from.id, to.id], fillFree: true });
    if (plan.plan.length > 0) await applyRoomFlagRepairs(prisma, plan.plan, plan.today);
    repaired++;
  }
  console.log(`\n${commit ? "Repaired" : "Would repair"}: ${commit ? repaired : entries.length - left}. Left for a person: ${left}.${commit ? "" : " Dry run: pass --commit to apply."}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
