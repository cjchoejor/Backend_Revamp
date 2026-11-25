/**
 * Who holds a room over some nights, and where they could go instead (2026-11-25). One reading for
 * every place the desk offers to move another booking out of the way: Extend the stay's "Move their
 * booking instead", and the apartments at Inquiry ("can I have the option to move the booking in the
 * room already staying inside this so I can accommodate the new guest here").
 *
 * The move itself is always the governed room move (`POST /room-moves`): their booking walks its own
 * new pass back to its step, keeps its price for the same type, and its papers are made again and
 * held. This only says who is there, whether the desk can move them now, and the rooms free for their
 * nights in that room — none of the caller's, same type first.
 */
import type { PrismaClient } from "@prisma/client";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { listRoomChangeCandidates } from "./room-change-service.js";

export type RoomHolder = {
  entryId: string;
  bookingRef: string | null;
  guestName: string | null;
  partyName: string | null;
  stage: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  /** The nights their booking holds this room (the nights a room move for them would cover). */
  nightsInRoom: string[];
  /** Whether their room can be moved from the desk now, and why not. */
  swappable: boolean;
  why: string | null;
  /** Rooms free for their nights in this room — none of the caller's; same type first. */
  rooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; sameType: boolean }>;
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function describeRoomHolders(
  prisma: PrismaClient,
  input: {
    roomIds: string[];
    checkIn: Date;
    checkOut: Date;
    /** The caller's own booking — never a holder. */
    excludeEntryId: string;
    /** Rooms a holder must not be moved into (the caller's, the apartment being made room in). */
    avoidRoomIds: Set<string>;
  },
): Promise<Map<string, RoomHolder[]>> {
  const out = new Map<string, RoomHolder[]>();
  if (!input.roomIds.length || input.checkOut.getTime() <= input.checkIn.getTime()) return out;
  const conflicts = await findRoomBookingConflicts(prisma, {
    roomIds: input.roomIds,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    excludeEntryId: input.excludeEntryId,
  });
  const holderIds = Array.from(new Set(conflicts.map((c) => c.entryId)));
  const holders = holderIds.length
    ? await prisma.entry.findMany({
        where: { id: { in: holderIds } },
        select: {
          id: true,
          currentStage: true,
          status: true,
          useType: true,
          apartmentPlan: true,
          checkInDate: true,
          checkOutDate: true,
          inquiry: { select: { travelAgent: { select: { displayName: true } }, corporateAccount: { select: { displayName: true } } } },
        },
      })
    : [];
  const holderById = new Map(holders.map((h) => [h.id, h]));
  const day = (d: Date | null | undefined) => (d ? isoDay(d) : null);
  for (const roomId of input.roomIds) {
    const heldBy: RoomHolder[] = [];
    for (const holderId of Array.from(new Set(conflicts.filter((c) => c.roomId === roomId).map((c) => c.entryId)))) {
      const c = conflicts.find((x) => x.roomId === roomId && x.entryId === holderId)!;
      const h = holderById.get(holderId);
      const stage = String(h?.currentStage ?? "");
      const status = String(h?.status ?? "");
      let why: string | null = null;
      if (!h) why = "That booking could not be read";
      else if (status === "PARKED") why = "Their booking is parked — resume it first";
      else if (status !== "ACTIVE") why = "Their booking has ended";
      else if (stage === "S1" || stage === "S2") why = "Their booking is still at Inquiry or Negotiation — change its rooms on that booking";
      else if (stage === "S8" || stage === "S9") why = "Their booking is checking out";
      else if (String(h.useType) === "APARTMENT" && h.apartmentPlan) {
        why = "Their booking is an apartment let by the month or the week — change its apartment on that booking";
      }
      let nightsInRoom: string[] = [];
      let rooms: RoomHolder["rooms"] = [];
      if (!why) {
        try {
          const cand = await listRoomChangeCandidates(prisma, holderId, roomId);
          nightsInRoom = cand.substitutionNights;
          rooms = cand.candidates
            .filter((x) => x.selectable && !input.avoidRoomIds.has(x.roomId))
            .sort((a, b) => Number(b.sameType) - Number(a.sameType) || String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }))
            .map((x) => ({ roomId: x.roomId, roomNumber: x.roomNumber, roomTypeName: x.roomTypeName, sameType: x.sameType }));
          if (rooms.length === 0) why = "No other room is free for their nights";
        } catch (e) {
          why = e instanceof Error ? e.message : "Their room cannot be moved";
        }
      }
      heldBy.push({
        entryId: holderId,
        bookingRef: c.entryReferenceNumber ?? null,
        guestName: c.guestName ?? null,
        partyName: h?.inquiry?.travelAgent?.displayName ?? h?.inquiry?.corporateAccount?.displayName ?? null,
        stage,
        status,
        checkIn: day(h?.checkInDate),
        checkOut: day(h?.checkOutDate),
        nightsInRoom,
        swappable: !why,
        why,
        rooms,
      });
    }
    out.set(roomId, heldBy);
  }
  return out;
}
