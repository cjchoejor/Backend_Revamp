/**
 * Another booking holding a room, in the desk's words (2026-11-27, operator on a night move refused
 * with "Room is not available for committed hold — Room 304 is reserved 2026-11-29→2026-11-30 by
 * INQ-20261124-0002 · Ms Solanki Mayankkumar"). One reading for the committed hold (Policy 26) and
 * the provisional block (Policy 25): the room, whose booking it is, and the nights it holds.
 *
 * "Room 304 is reserved for Ms Solanki Mayankkumar (ENT-20261124-0003) on the night of 29 Nov".
 */
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

/** A stored stay date (UTC midnight) as "29 Nov". */
function dayWords(d: Date) {
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The nights from `start` up to the morning `end` (exclusive): "the night of 29 Nov" / "the nights of 29 Nov to 1 Dec". */
export function nightsWords(start: Date, end: Date) {
  const last = new Date(Math.max(start.getTime(), end.getTime() - DAY));
  return last.getTime() === start.getTime() ? `the night of ${dayWords(start)}` : `the nights of ${dayWords(start)} to ${dayWords(last)}`;
}

export function describeRoomConflict(c: {
  roomNumber?: string | null;
  source: "RESERVED" | "HOLD";
  entryId?: string | null;
  entryReferenceNumber: string | null;
  guestName: string | null;
  startDate: Date;
  endDate: Date;
}) {
  const room = c.roomNumber ? `Room ${c.roomNumber}` : "The room";
  const label = c.source === "RESERVED" ? "reserved" : "held";
  const ref = c.entryId ?? c.entryReferenceNumber;
  const whose = c.guestName ? ` for ${c.guestName}${ref ? ` (${ref})` : ""}` : ref ? ` for ${ref}` : " for another booking";
  return `${room} is ${label}${whose} on ${nightsWords(c.startDate, c.endDate)}`;
}

/** Several conflicts as one sentence each, joined. */
export function describeRoomConflicts(cs: Parameters<typeof describeRoomConflict>[0][]) {
  return cs.map(describeRoomConflict).join("; ");
}
