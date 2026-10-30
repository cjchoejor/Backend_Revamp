import { StageGateBlockedError } from "../../lib/errors.js";

type UnavailableRoom = { inventoryId?: string; roomId?: string; unavailabilityReason?: string };

/**
 * Policy 1 — Availability configuration selection (SIG-S1→S2 slice).
 */
export function enforcePreferredAvailabilityConfigurationSelectedForS1Exit(input: { preferred: unknown | null | undefined }) {
  if (input.preferred) return;
  throw new StageGateBlockedError(
    "No rooms are chosen for this pass — ask the house for the dates and take the rooms (a new pass searches again)",
    "NO_PREFERRED_CONFIGURATION",
  );
}

const DAY_MS = 86_400_000;
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const shortDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
};

/**
 * Why a saved room pick no longer fits the stay as it stands — or null when it does (2026-10-27,
 * operator: the stay was changed after the rooms were chosen, from 2 rooms a night to 3, and the
 * booking read as ready to move on). The room save already demands exactly the asked number of
 * rooms on every night of the stay; a later change of dates or room count left the old pick
 * standing, and the exit took any pick at all — so a booking could reach Negotiation with a night
 * that has no room, or fewer rooms than asked, and be priced and held on that.
 *
 * - A per-night pick must name every night of the stay, no night outside it, and the asked number
 *   of rooms on each.
 * - A whole-stay pick (one list of rooms) was checked only for the dates it was searched for, so
 *   those dates must still be the stay's, and the list must hold the asked number of rooms.
 *
 * The desk mirrors this in `pickFitsStay` (new_front_end lib/desk/workspace.ts) — keep in step.
 */
export function pickDoesNotFitStay(input: {
  optionSelected: unknown;
  searchCriteria: unknown;
  checkInDate: Date | null;
  checkOutDate: Date | null;
  numberOfRooms: number | null;
}): string | null {
  const ci = ymd(input.checkInDate);
  const co = ymd(input.checkOutDate);
  if (!ci || !co) return null;
  const nights: string[] = [];
  for (let t = Date.parse(`${ci}T00:00:00Z`); t < Date.parse(`${co}T00:00:00Z`) && nights.length < 366; t += DAY_MS) {
    nights.push(new Date(t).toISOString().slice(0, 10));
  }
  const want = Math.max(1, input.numberOfRooms ?? 1);
  const rooms = (n: number) => `${n} room${n === 1 ? "" : "s"}`;
  const opt = input.optionSelected as {
    perNight?: Array<{ date: string; roomIds?: unknown[] }>;
    roomIds?: unknown[];
    roomId?: string;
  } | null;
  if (!opt) return null;
  if (Array.isArray(opt.perNight) && opt.perNight.length > 0) {
    const byNight = new Map(opt.perNight.map((n) => [String(n.date).slice(0, 10), Array.isArray(n.roomIds) ? n.roomIds.length : 0]));
    const outside = [...byNight.keys()].filter((d) => !nights.includes(d)).sort();
    const missing = nights.filter((d) => !byNight.has(d) || byNight.get(d) === 0);
    const wrong = nights.filter((d) => byNight.has(d) && byNight.get(d)! > 0 && byNight.get(d) !== want);
    if (missing.length) return `no room is chosen for ${missing.map(shortDay).join(", ")}`;
    if (outside.length) return `rooms are still chosen for ${outside.map(shortDay).join(", ")}, which is no longer part of the stay`;
    if (wrong.length) {
      const had = byNight.get(wrong[0])!;
      return `${rooms(had)} ${had === 1 ? "is" : "are"} chosen for ${wrong.map(shortDay).join(", ")} — ${rooms(want)} a night are asked now`;
    }
    return null;
  }
  const sc = (input.searchCriteria ?? {}) as { checkInDate?: unknown; checkOutDate?: unknown };
  const sci = typeof sc.checkInDate === "string" ? sc.checkInDate.slice(0, 10) : null;
  const sco = typeof sc.checkOutDate === "string" ? sc.checkOutDate.slice(0, 10) : null;
  if (sci && sco && (sci !== ci || sco !== co)) {
    return `the rooms were chosen for ${shortDay(sci)} → ${shortDay(sco)}, and the stay is now ${shortDay(ci)} → ${shortDay(co)}`;
  }
  const count = Array.isArray(opt.roomIds) ? opt.roomIds.length : opt.roomId ? 1 : 0;
  if (count !== want) return `${rooms(count)} ${count === 1 ? "is" : "are"} chosen — ${rooms(want)} are asked now`;
  return null;
}

export function enforcePreferredPickFitsStayForS1Exit(input: Parameters<typeof pickDoesNotFitStay>[0]) {
  const why = pickDoesNotFitStay(input);
  if (!why) return;
  throw new StageGateBlockedError(
    `The rooms chosen no longer fit the stay — ${why}. Ask the house and choose the rooms again.`,
    "PICK_DOES_NOT_FIT_STAY",
  );
}

export function enforcePreferredAvailabilityConfigurationNotStaleForS1Exit(input: { isStale: boolean }) {
  if (!input.isStale) return;
  throw new StageGateBlockedError("Preferred configuration is stale", "PREFERRED_CONFIGURATION_STALE");
}

export function enforceDeficientAcknowledgementsWhenRequiredForS1Exit(input: {
  optionSelected: unknown;
  deficientAcknowledgements: unknown;
}) {
  const selected = input.optionSelected as { isDeficient?: boolean } | null | undefined;
  const needsAck = selected && selected.isDeficient === true;
  if (!needsAck) return;
  const da = input.deficientAcknowledgements;
  if (da && Array.isArray(da) && da.length > 0) return;
  if (da && !Array.isArray(da)) return;
  throw new StageGateBlockedError("DEFICIENT acknowledgement required", "DEFICIENT_ACK_REQUIRED");
}

export function enforceSelectedRoomNotMaintenanceOrBlockedForS1Exit(input: {
  selectedRoomId: string | undefined;
  resultSet: { unavailableRooms?: UnavailableRoom[] } | null | undefined;
}) {
  if (typeof input.selectedRoomId !== "string") return;
  const rs = input.resultSet ?? {};
  const unavailable = (rs.unavailableRooms ?? []).find(
    (r) => r.inventoryId === input.selectedRoomId || r.roomId === input.selectedRoomId,
  );
  if (unavailable?.unavailabilityReason === "MAINTENANCE_CONFLICT") {
    throw new StageGateBlockedError("Selected option has maintenance conflict", "MAINTENANCE_CONFLICT");
  }
  if (unavailable?.unavailabilityReason === "BLOCKED") {
    throw new StageGateBlockedError("Selected option is blocked", "ROOM_BLOCKED");
  }
}
