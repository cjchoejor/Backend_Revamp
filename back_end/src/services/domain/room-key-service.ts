import type { PrismaClient } from "@prisma/client";
import { NotFoundError, StageGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Per-room key lifecycle (2026-08-14, operator ruling).
 *
 * A key is issued per room, on the day the guest actually enters that room — check-in is
 * just the FIRST such day. A per-night split (202 → 501 nights 1–2 + 302 night 3) makes the
 * move day a key SWAP: the vacated room's key comes back, and only then does the new room's
 * key go out (HARD gate — operator ruling over the softer warn-only alternative).
 *
 * Stamps live on the RoomAssignment row (keyIssuedAt/By, keyReturnedAt/By) because that row
 * IS the (room, date-range) claim the key covers: a room change end-dates or deletes the row
 * and the key story follows it. The FINAL checkout key collection stays the S8
 * KeyReturnRecord ceremony — but it now reconciles against the outstanding stamps
 * (see s8-checkout-service).
 */

const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

type KeyAssignmentRow = {
  id: string;
  roomId: string;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  keyIssuedAt: Date | null;
  keyReturnedAt: Date | null;
};

/** The row that carries a room's key story: earliest-starting live range (null start = whole stay = earliest). */
function keyRowForRoom(rows: KeyAssignmentRow[]): KeyAssignmentRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const sa = a.startDate ? isoDay(a.startDate) : "";
    const sb = b.startDate ? isoDay(b.startDate) : "";
    if (sa !== sb) return sa.localeCompare(sb);
    return b.createdAt.getTime() - a.createdAt.getTime();
  })[0];
}

/** A room's stay windows as half-open ISO-day ranges; null start/end falls back to the booking dates. */
function roomRangesIso(
  rows: KeyAssignmentRow[],
  checkInDate: Date | null,
  checkOutDate: Date | null,
): Array<{ start: string | null; end: string | null }> {
  return rows.map((r) => ({
    start: r.startDate ? isoDay(r.startDate) : checkInDate ? isoDay(checkInDate) : null,
    end: r.endDate ? isoDay(r.endDate) : checkOutDate ? isoDay(checkOutDate) : null,
  }));
}

/** Half-open range overlap; an undatable range counts as overlapping (can't sequence → never block). */
function rangesOverlap(a: { start: string | null; end: string | null }, b: { start: string | null; end: string | null }): boolean {
  if (!a.start || !a.end || !b.start || !b.end) return true;
  return a.start < b.end && b.start < a.end;
}

async function loadEntryForKeys(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

function groupByRoom<T extends { roomId: string }>(rows: T[]): Map<string, T[]> {
  const byRoom = new Map<string, T[]>();
  for (const r of rows) byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r]);
  return byRoom;
}

/**
 * Which of the entry's assigned rooms are occupied on the ARRIVAL night — the only rooms
 * whose keys are issued at S6 check-in. A room the plan moves the guest into later gets its
 * key at S7, on the move day, after the vacated room's key is back. Shared by the check-in
 * stamping and its refusal path so the two can't disagree.
 */
export function dayOneRoomIds(
  assignments: Array<{ roomId: string; startDate: Date | null }>,
  checkInDate: Date | null,
): Set<string> {
  const out = new Set<string>();
  const checkInIso = checkInDate ? isoDay(checkInDate) : null;
  for (const [roomId, rows] of groupByRoom(assignments)) {
    // No stay dates at all → no way to sequence keys; treat every room as day-one.
    if (!checkInIso) {
      out.add(roomId);
      continue;
    }
    const dayOne = rows.some((r) => !r.startDate || isoDay(r.startDate) <= checkInIso);
    if (dayOne) out.add(roomId);
  }
  return out;
}

/**
 * Issue THIS room's key (L1 desk act, S6–S7). Hard gate per the 2026-08-14 ruling: two rooms
 * whose night ranges are DISJOINT are sequential — the same party carries one key set — so
 * their keys can never both be out. Any other room with an outstanding key and no night in
 * common with this one blocks the issue (BOTH directions — the first cut only looked at
 * predecessors, so re-issuing the earlier room while the later one's key was out slipped
 * through). Parallel rooms — overlapping ranges — never block each other.
 */
export async function issueRoomKey(prisma: PrismaClient, entryId: string, roomId: string, actorId: string) {
  const entry = await loadEntryForKeys(prisma, entryId);
  if (entry.status !== "ACTIVE") throw new ValidationError(`Entry is ${entry.status} — keys can only move on an active booking`);
  if (entry.currentStage !== "S6" && entry.currentStage !== "S7") {
    throw new ValidationError(`Key issuance is an S6/S7 act (entry is at ${entry.currentStage})`);
  }
  const rows = entry.roomAssignments.filter((a) => a.roomId === roomId);
  if (rows.length === 0) throw new NotFoundError("RoomAssignment");
  const target = keyRowForRoom(rows)!;
  const room = rows[0].room;

  if (rows.some((r) => r.keyIssuedAt && !r.keyReturnedAt)) {
    throw new ValidationError(`Room ${room.roomNumber}'s key is already out`);
  }

  // The hard gate: any sequential (disjoint-nights) room with its key still out.
  const targetRanges = roomRangesIso(rows, entry.checkInDate, entry.checkOutDate);
  const blockers: Array<{ roomId: string; roomNumber: string }> = [];
  for (const [otherRoomId, otherRows] of groupByRoom(entry.roomAssignments)) {
    if (otherRoomId === roomId) continue;
    const outstanding = otherRows.some((r) => r.keyIssuedAt && !r.keyReturnedAt);
    if (!outstanding) continue;
    const otherRanges = roomRangesIso(otherRows, entry.checkInDate, entry.checkOutDate);
    const disjoint = !otherRanges.some((o) => targetRanges.some((t) => rangesOverlap(t, o)));
    if (disjoint) blockers.push({ roomId: otherRoomId, roomNumber: otherRows[0].room.roomNumber });
  }
  if (blockers.length > 0) {
    const names = blockers.map((b) => b.roomNumber).join(", ");
    throw new StageGateBlockedError(
      `Room ${names}'s key is still with the guest — the party uses these rooms one after another, so take it back before issuing Room ${room.roomNumber}'s`,
      "PRIOR_ROOM_KEY_OUTSTANDING",
    );
  }

  const reissue = !!target.keyIssuedAt;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.roomAssignment.update({
      where: { id: target.id },
      data: { keyIssuedAt: now, keyIssuedBy: actorId, keyReturnedAt: null, keyReturnedBy: null },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ROOM_KEY.ISSUED",
        actorId,
        actorLevel: "L1",
        entityType: "RoomAssignment",
        entityId: target.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, roomId, roomNumber: room.roomNumber, reissue, stage: entry.currentStage },
        createdBy: actorId,
      },
    });
    return { assignment: updated, roomNumber: room.roomNumber, reissue };
  });
}

/**
 * Record THIS room's key back at the desk mid-stay (the vacated half of a room-change swap).
 * S6–S8; the S8 KeyReturnRecord ceremony remains the final whole-booking reconciliation.
 */
export async function returnRoomKey(prisma: PrismaClient, entryId: string, roomId: string, actorId: string) {
  const entry = await loadEntryForKeys(prisma, entryId);
  if (entry.status !== "ACTIVE") throw new ValidationError(`Entry is ${entry.status} — keys can only move on an active booking`);
  if (!["S6", "S7", "S8"].includes(entry.currentStage)) {
    throw new ValidationError(`Key return is an S6–S8 act (entry is at ${entry.currentStage})`);
  }
  const rows = entry.roomAssignments.filter((a) => a.roomId === roomId);
  if (rows.length === 0) throw new NotFoundError("RoomAssignment");
  const room = rows[0].room;
  const outstanding = rows.filter((r) => r.keyIssuedAt && !r.keyReturnedAt);
  if (outstanding.length === 0) {
    throw new ValidationError(`Room ${room.roomNumber} has no key out to return`);
  }

  // A key comes back only once the guest is OUT of the room (2026-08-16, operator ruling):
  // the room's last night must be done — its latest end (the exclusive move-out morning) has
  // arrived. Until then the key is simply with the guest. Undated rows fall back to the
  // booking's checkout; no dates at all → nothing to sequence, allow.
  const todayIso = isoDay(new Date());
  const lastEnd = roomRangesIso(rows, entry.checkInDate, entry.checkOutDate).reduce<string | null>(
    (acc, r) => (r.end && (!acc || r.end > acc) ? r.end : acc),
    null,
  );
  if (lastEnd && lastEnd > todayIso) {
    const pretty = new Date(`${lastEnd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    throw new ValidationError(
      `The guest sleeps in Room ${room.roomNumber} until ${pretty} — the key comes back when they move out`,
    );
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Per-row updates — the db.ts guard forbids roomAssignment.updateMany wholesale.
    for (const r of outstanding) {
      await tx.roomAssignment.update({
        where: { id: r.id },
        data: { keyReturnedAt: now, keyReturnedBy: actorId },
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "ROOM_KEY.RETURNED",
        actorId,
        actorLevel: "L1",
        entityType: "RoomAssignment",
        entityId: outstanding[0].id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, roomId, roomNumber: room.roomNumber, stage: entry.currentStage },
        createdBy: actorId,
      },
    });
    return { roomNumber: room.roomNumber };
  });
}

/**
 * Keys the guest still holds = rows issued and not returned. Drives the S8 reconciliation;
 * falls back to the legacy Entry.keysIssuedCount when no row anywhere carries a stamp
 * (bookings checked in before 2026-08-14, or count-only API callers).
 */
export async function countOutstandingKeys(prisma: PrismaClient, entryId: string): Promise<number | null> {
  const anyStamped = await prisma.roomAssignment.count({ where: { entryId, keyIssuedAt: { not: null } } });
  if (anyStamped === 0) return null;
  // Outstanding per ROOM (a room's key is one physical object even if it spans two ranges).
  const rows = await prisma.roomAssignment.findMany({
    where: { entryId, keyIssuedAt: { not: null }, keyReturnedAt: null },
    select: { roomId: true },
  });
  return new Set(rows.map((r) => r.roomId)).size;
}
