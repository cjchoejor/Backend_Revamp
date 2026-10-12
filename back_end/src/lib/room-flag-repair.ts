/**
 * Putting room claim flags back in line with the bookings that hold the room (2026-10-12).
 *
 * `Room.currentClaimState` is a NOW snapshot the Rooms board reads, and check-out insists on
 * OCCUPIED. The flows set and clear it as bookings move, but a flag can be left behind — a booking
 * erased (`delete-booking.ts` also erases its claim-event history), a test fixture cleaned, a
 * booking re-entered after check-in, the legacy import. Room AVAILABILITY never reads the flag (it
 * is decided by dates), so a stale flag misleads the board rather than blocking a sale — except a
 * guest in house whose room does not read OCCUPIED, whose check-out is then refused.
 *
 * What the room's bookings say ("expected"):
 *   - OCCUPIED — a guest is in it: a booking at Stay or Check-out (active or parked) whose
 *     assignment covers tonight, or that is still in after its checkout in its final room WHILE
 *     that room still reads OCCUPIED (the house chart's rule — a booking left at Stay long after
 *     its dates, whose room has since gone to other guests, is not assumed to be in it);
 *   - else the strongest live claim from today on: a reservation → CONFIRMED (COMMITTED_HELD while
 *     the advance is short), a committed hold → COMMITTED_HELD, a provisional block →
 *     SPECULATIVELY_HELD — read with `findRoomBookingConflicts`, the S3 gate's own reader;
 *   - else FREE.
 *
 * When a flag is changed:
 *   - OCCUPIED with no guest in the room → expected;
 *   - held / confirmed with no live claim from today on → FREE;
 *   - "departed" (needs cleaning / cleaned) with nothing behind it — set by a booking that no
 *     longer exists, or with no claim event recording it at all (every path that writes a
 *     departed flag writes one; only an erased booking's history leaves it bare) → expected;
 *   - anything else while a guest IS in the room → OCCUPIED (else check-out is refused).
 * Left alone: a departed flag a real booking set (housekeeping's), and a held / confirmed flag
 * some live booking still backs (which of several bookings it names is a display nuance).
 *
 * Every change goes through `transitionRoomClaimState`, so it writes a RoomClaimStateEvent.
 */
import type { InventoryClaimState, PrismaClient } from "@prisma/client";
import { findRoomBookingConflicts } from "./room-booking-conflicts.js";
import { transitionRoomClaimState } from "./room-claim-state.js";
import { effectiveCheckOutDate, hotelTodayUtc, ymdUtc } from "./stay-dates.js";

const CLAIM: InventoryClaimState[] = ["SPECULATIVELY_HELD", "COMMITTED_HELD", "CONFIRMED"];

export type RoomFlagRepair = { roomId: string; roomNumber: string; from: InventoryClaimState; to: InventoryClaimState; why: string };

export async function planRoomFlagRepairs(
  prisma: PrismaClient,
  opts: { roomIds?: string[]; except?: Set<string>; now?: Date } = {},
): Promise<{ today: Date; guestsIn: number; plan: RoomFlagRepair[]; skipped: string[] }> {
  const today = hotelTodayUtc(opts.now);
  const except = opts.except ?? new Set<string>();
  const rooms = await prisma.room.findMany({
    where: opts.roomIds ? { id: { in: opts.roomIds } } : undefined,
    select: { id: true, roomNumber: true, currentClaimState: true },
  });
  rooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  if (rooms.length === 0) return { today, guestsIn: 0, plan: [], skipped: [] };
  const flagOf = new Map(rooms.map((r) => [r.id, r.currentClaimState]));

  // ---- who is in each room tonight ---------------------------------------------------
  const inHouse = await prisma.entry.findMany({
    where: {
      currentStage: { in: ["S7", "S8"] },
      status: { in: ["ACTIVE", "PARKED"] },
      noShowDetermination: { is: null },
      roomAssignments: { some: { roomId: { in: rooms.map((r) => r.id) } } },
    },
    select: {
      id: true,
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      roomAssignments: { select: { roomId: true, startDate: true, endDate: true } },
    },
  });
  const guestIn = new Map<string, string>(); // roomId -> entryId
  for (const e of inHouse) {
    if (!e.checkInDate || !e.checkOutDate) continue;
    const end = effectiveCheckOutDate(e) ?? e.checkOutDate;
    const overstaying = end.getTime() <= today.getTime();
    for (const a of e.roomAssignments) {
      if (!flagOf.has(a.roomId)) continue;
      const start = a.startDate ?? e.checkInDate;
      const rowEnd = a.endDate ?? end;
      const tonight = start.getTime() <= today.getTime() && today.getTime() < rowEnd.getTime();
      const finalRoom = overstaying && rowEnd.getTime() >= end.getTime() && flagOf.get(a.roomId) === "OCCUPIED";
      if (tonight || finalRoom) guestIn.set(a.roomId, e.id);
    }
  }

  // ---- the strongest live claim from today on ------------------------------------------
  const claims = await findRoomBookingConflicts(prisma, {
    roomIds: rooms.map((r) => r.id),
    checkIn: today,
    checkOut: new Date(Date.UTC(today.getUTCFullYear() + 10, 0, 1)),
    excludeEntryId: "",
  });
  const pending = new Set(
    (
      await prisma.entry.findMany({
        where: { id: { in: [...new Set(claims.map((c) => c.entryId))] }, reservationPaymentPending: true },
        select: { id: true },
      })
    ).map((e) => e.id),
  );
  const rank: Record<string, number> = { CONFIRMED: 3, COMMITTED_HELD: 2, SPECULATIVELY_HELD: 1 };
  const claimFlag = new Map<string, InventoryClaimState>();
  for (const c of claims) {
    const f: InventoryClaimState =
      c.source === "RESERVED"
        ? pending.has(c.entryId)
          ? "COMMITTED_HELD"
          : "CONFIRMED"
        : c.holdKind === "SPECULATIVE"
          ? "SPECULATIVELY_HELD"
          : "COMMITTED_HELD";
    const cur = claimFlag.get(c.roomId);
    if (!cur || rank[f] > rank[cur]) claimFlag.set(c.roomId, f);
  }

  // ---- decide, room by room ------------------------------------------------------------
  const plan: RoomFlagRepair[] = [];
  const skipped: string[] = [];
  for (const r of rooms) {
    const last = await prisma.roomClaimStateEvent.findFirst({
      where: { roomId: r.id },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      select: { entryId: true, toState: true },
    });
    const recorded = !!last && last.toState === r.currentClaimState;
    const setter = recorded ? last!.entryId : null;
    const setterGone = !!setter && !(await prisma.entry.findUnique({ where: { id: setter }, select: { id: true } }));
    const expected: InventoryClaimState = guestIn.has(r.id) ? "OCCUPIED" : (claimFlag.get(r.id) ?? "FREE");
    const from = r.currentClaimState;
    let why: string | null = null;
    if (guestIn.has(r.id) && from !== "OCCUPIED") why = `a guest is in the room (${guestIn.get(r.id)}) — check-out needs OCCUPIED`;
    else if (from === "OCCUPIED" && !guestIn.has(r.id)) why = "OCCUPIED but no guest is in the room";
    else if (CLAIM.includes(from) && !claimFlag.has(r.id)) why = `${from} but no booking holds the room from today on`;
    else if ((from === "DEPARTED_DIRTY" || from === "DEPARTED_CLEAN") && (setterGone || !recorded)) {
      why = setterGone ? `${from} set by ${setter}, which no longer exists` : `${from} with no claim event behind it (its booking was erased)`;
    }
    if (!why || expected === from) continue;
    const because = guestIn.get(r.id);
    if ((setter && except.has(setter)) || (because && except.has(because))) {
      skipped.push(
        `${r.roomNumber}: ${from} → ${expected} would apply (${why}) — left alone: ${setter && except.has(setter) ? `set by ${setter}` : `${because} is in it`}`,
      );
      continue;
    }
    plan.push({ roomId: r.id, roomNumber: r.roomNumber, from, to: expected, why });
  }
  return { today, guestsIn: guestIn.size, plan, skipped };
}

/** Apply a plan in one transaction — each change audited as SYSTEM_REPAIR with its rule. */
export async function applyRoomFlagRepairs(prisma: PrismaClient, plan: RoomFlagRepair[], today: Date): Promise<number> {
  if (plan.length === 0) return 0;
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      await transitionRoomClaimState(tx, {
        roomId: p.roomId,
        toState: p.to,
        actorId: "SYSTEM_REPAIR",
        entryId: null,
        reason: `Room flag repair ${ymdUtc(today)}: ${p.why}`,
      });
    }
  });
  return plan.length;
}
