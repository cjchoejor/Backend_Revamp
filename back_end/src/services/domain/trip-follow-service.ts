/**
 * A return stay set up "the same as this stay" (2026-11-03, operator: "in the second entry it will
 * copy the exact infos like in entry 1 like adults, children age, room and selected room types and
 * also the configurations like meal types and all, they will have the same info till s2, and if
 * their selected room type in entry one is not available in entry 2, prompt the user").
 *
 * The desk adds a return stay as soon as the first stay's dates and party are typed, before any
 * room or meal is chosen, so a copy made once would copy almost nothing. The new stay therefore
 * FOLLOWS the stay it was added from (`Entry.followsEntryId`) until it is priced or changed by hand:
 *
 *  - **The guests, the rooms asked for, the bed ask, the kind of stay, who is arriving and the guest
 *    staying** are written to it while it sits at Inquiry.
 *  - **The rooms by type** are saved on its own nights (night by night, by position in the stay; a
 *    longer stay repeats the last night), the system choosing its own rooms. A room the first stay
 *    fixed by number is kept when it is free then. Past Inquiry its rooms are its own.
 *
 *  - **The table** — guests per room, meal plans, extra beds, rates, the discount, the bed plan — is
 *    kept in `carryOver`, on this stay's rooms, when the stay it follows has been quoted (2026-11-09,
 *    operator: "from stage 2 and above if user add a return stay then it can ask that where if chosen
 *    same, it can pull the same room types, configuration and stay details as stay 1"). It is never
 *    priced here: this stay's own Save prices it, for its own dates. A rate negotiated for another
 *    room type is left behind.
 *
 * Only while it sits at Inquiry. The choice itself stays on `Entry.sameSetupAs`, and at Negotiation
 * those stays are one table: nothing is copied there.
 *
 * A pick holds nothing at Inquiry, so copying takes no room from anyone. Each write goes through the
 * ordinary service, with every one of its checks, and is traced on the stay it changes.
 *
 * When the rooms cannot be copied (a type is not free on these nights) nothing is changed: the
 * refusal is kept on `followState.shortfall` and the desk asks, offering the types that are free.
 */
import { Prisma, type ActorLevel, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { readBookingRooms, typeCountsPerNight, type BookingRoom } from "../../lib/booking-rooms.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { listNightYmdsUtc, utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";
import * as auditService from "../infrastructure/audit-service.js";
import { setEntryGuest } from "./inquiry-caller-service.js";
import { planRoomsByTypeForStay, sealBookingRoomsByType, type SealByTypeInput } from "./quiet-rooms-service.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
import { answerHouseByType, currentPassSeal, sealSelect } from "./room-placement-service.js";
import { effectiveAllowedBedTypes } from "./room-bed-type-service.js";
import { queryAvailability } from "./s1-availability-service.js";
import { updateEntryIntakeFields } from "./s1-entry-service.js";

type Actor = { actorId: string; actorLevel: ActorLevel };

const ENDED = new Set(["CANCELLED", "EXPIRED", "CLOSED"]);
const LIVE_QUOTE = new Set(["DRAFT", "SENT", "ACCEPTED"]);

const stayFields = {
  id: true,
  inquiryId: true,
  status: true,
  currentStage: true,
  followsEntryId: true,
  followState: true,
  guestProfileId: true,
  checkInDate: true,
  checkOutDate: true,
  adultCount: true,
  childCount: true,
  childAges: true,
  guestCount: true,
  numberOfRooms: true,
  bedTypeRequest: true,
  bedPlan: true,
  ratePackageByRoomType: true,
  useType: true,
  contactPersonName: true,
  contactPersonPhone: true,
  contactPersonEmail: true,
  ...sealSelect,
  quotations: { select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true } },
} as const;

async function loadStay(prisma: PrismaClient, id: string) {
  return prisma.entry.findUnique({ where: { id }, select: stayFields });
}
type Stay = NonNullable<Awaited<ReturnType<typeof loadStay>>>;

export type FollowShortfall = {
  /** What was being copied — the same rooms are not asked about twice. */
  key: string;
  refusals: string[];
  wanted: Array<{ roomTypeId: string; count: number }>;
};

type FollowState = {
  roomsCanon?: string;
  /** The package per room type last copied (2026-11-13) — a choice made on this stay stands until the other changes. */
  packagesCanon?: string;
  tableCanon?: string;
  shortfall?: FollowShortfall | null;
  notes?: string[];
};

function stateOf(s: Pick<Stay, "followState">): FollowState {
  return s.followState && typeof s.followState === "object" && !Array.isArray(s.followState) ? (s.followState as FollowState) : {};
}

const nightsOf = (s: Pick<Stay, "checkInDate" | "checkOutDate">): string[] =>
  s.checkInDate && s.checkOutDate ? listNightYmdsUtc(utcDateOnly(s.checkInDate), utcDateOnly(s.checkOutDate)) : [];

function partyCanon(s: Stay): string {
  return JSON.stringify([
    s.adultCount,
    s.childCount,
    s.childAges ?? [],
    s.guestCount,
    s.numberOfRooms,
    s.bedTypeRequest ?? null,
    s.useType,
    s.contactPersonName,
    s.contactPersonPhone,
    s.contactPersonEmail,
  ]);
}

async function roomLookup(prisma: PrismaClient) {
  const rooms = await prisma.room.findMany({ select: { id: true, roomTypeId: true, roomNumber: true } });
  const firstOfType = new Map<string, string>();
  for (const r of rooms) if (!firstOfType.has(r.roomTypeId)) firstOfType.set(r.roomTypeId, r.id);
  return {
    typeOf: new Map(rooms.map((r) => [r.id, r.roomTypeId] as const)),
    numberOf: new Map(rooms.map((r) => [r.id, r.roomNumber] as const)),
    firstOfType,
  };
}

function bookingRoomsOf(s: Stay, typeOf: Map<string, string>): BookingRoom[] {
  // A stay sent back to Negotiation keeps the rooms of its last pass until they are chosen again.
  const seal = currentPassSeal(s) ?? (s.currentStage !== "S1" ? (s.availabilityConfigs.find((c) => c.optionSelected != null)?.optionSelected ?? null) : null);
  if (!seal || !s.checkInDate || !s.checkOutDate) return [];
  return readBookingRooms(seal, { checkIn: utcDateOnly(s.checkInDate), checkOut: utcDateOnly(s.checkOutDate) }, (id) => typeOf.get(id));
}

/** The real rooms of a set of booking rooms, in order, each with its type and nights. */
function realRooms(rooms: BookingRoom[]): Array<{ roomId: string; roomTypeId: string; nights: string[] }> {
  const out = new Map<string, { roomId: string; roomTypeId: string; nights: string[] }>();
  for (const r of rooms) {
    for (const n of r.nights) {
      if (!n.roomId) continue;
      const row = out.get(n.roomId) ?? { roomId: n.roomId, roomTypeId: n.roomTypeId, nights: [] };
      row.nights.push(n.date);
      out.set(n.roomId, row);
    }
  }
  return [...out.values()];
}

export type TableRow = Record<string, unknown> & { roomId: string };

/**
 * The first stay's table on this stay's rooms. Each room here takes a row from a room of its own
 * type, else any row left; a row taken by another type leaves its negotiated room rate behind, since
 * that rate was agreed for the other type. A night's own meals go to the night at the same place in
 * this stay, and are dropped when this stay has no such night. A row with no room here is dropped.
 */
export function mapTableToStay(input: {
  rows: TableRow[];
  typeOfSourceRoom: (roomId: string) => string | null | undefined;
  stayRooms: Array<{ roomId: string; roomTypeId: string; nights: string[] }>;
  sourceNights: string[];
  stayNights: string[];
}): { rows: TableRow[]; pairs: Array<[string, string]> } {
  const used = new Set<number>();
  const rows: TableRow[] = [];
  const pairs: Array<[string, string]> = [];
  for (const room of input.stayRooms) {
    let at = input.rows.findIndex((r, i) => !used.has(i) && input.typeOfSourceRoom(r.roomId) === room.roomTypeId);
    const sameType = at >= 0;
    if (!sameType) at = input.rows.findIndex((_r, i) => !used.has(i));
    if (at < 0) continue;
    used.add(at);
    const row: TableRow = { ...input.rows[at], roomId: room.roomId };
    delete row.startDate;
    delete row.endDate;
    delete row.nightDates;
    if (!sameType) delete row.negotiatedRoomRate;
    if (Array.isArray(row.nightMealOverrides)) {
      const moved: unknown[] = [];
      for (const o of row.nightMealOverrides as Array<Record<string, unknown>>) {
        const offset = input.sourceNights.indexOf(String(o.date ?? "").slice(0, 10));
        const night = offset >= 0 ? input.stayNights[offset] : undefined;
        if (night && room.nights.includes(night)) moved.push({ ...o, date: night });
      }
      if (moved.length) row.nightMealOverrides = moved;
      else delete row.nightMealOverrides;
    }
    rows.push(row);
    pairs.push([input.rows[at].roomId, room.roomId]);
  }
  return { rows, pairs };
}

type TypeCount = { roomTypeId: string; count: number };

/** The first stay's rooms as what they ask for: the mix of types by position in the stay, and the rooms fixed by number. */
function roomsAsked(source: Stay, typeOf: Map<string, string>): { mix: TypeCount[][]; fixed: string[] } | null {
  const rooms = bookingRoomsOf(source, typeOf);
  if (rooms.length === 0) return null;
  const counts = typeCountsPerNight(rooms);
  const mix = nightsOf(source)
    .map((d) =>
      [...(counts.get(d) ?? new Map<string, number>()).entries()]
        .map(([roomTypeId, count]) => ({ roomTypeId, count }))
        .sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId)),
    )
    .filter((m) => m.length > 0);
  if (mix.length === 0) return null;
  const fixed = [...new Set(rooms.flatMap((r) => r.nights.filter((n) => n.fixed && n.roomId).map((n) => n.roomId!)))].sort();
  return { mix, fixed };
}

function wantedOf(mix: TypeCount[][]): TypeCount[] {
  const most = new Map<string, number>();
  for (const night of mix) for (const t of night) most.set(t.roomTypeId, Math.max(most.get(t.roomTypeId) ?? 0, t.count));
  return [...most.entries()].map(([roomTypeId, count]) => ({ roomTypeId, count }));
}

/** A fresh answer from the house for the stay, and the pick saved on it. */
async function saveRooms(prisma: PrismaClient, actor: Actor, stay: Stay, perNight: SealByTypeInput["perNight"], fixedRoomIds: string[]) {
  const { configuration } = await queryAvailability(prisma, stay.id, actor.actorId, actor.actorLevel, {
    checkInDate: ymdUtc(stay.checkInDate!),
    checkOutDate: ymdUtc(stay.checkOutDate!),
    guestCount: stay.guestCount ?? undefined,
  });
  await sealBookingRoomsByType(prisma, stay.id, actor as never, { configurationId: configuration.id, perNight, fixedRoomIds });
}

async function trace(prisma: PrismaClient, actor: Actor, stay: { id: string; inquiryId: string }, eventType: string, payload: Record<string, unknown>) {
  await auditService.emit(prisma, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType,
    entityType: "Entry",
    entityId: stay.id,
    operation: "UPDATE",
    timestamp: new Date(),
    inquiryId: stay.inquiryId,
    entryId: stay.id,
    payload: payload as Prisma.InputJsonValue,
  });
}

export type FollowCause =
  | "PRICED"
  | "MOVED_ON"
  | "CHANGED_HERE"
  | "ROOMS_CHOSEN_HERE"
  | "GUEST_NAMED_HERE"
  | "SET_ITS_OWN"
  | "FIRST_STAY_ENDED"
  | "FIRST_STAY_GONE";

async function endFollowing(prisma: PrismaClient, actor: Actor, stay: { id: string; inquiryId: string; followsEntryId: string | null }, cause: FollowCause) {
  await prisma.entry.update({ where: { id: stay.id }, data: { followsEntryId: null, followState: Prisma.DbNull } });
  await trace(prisma, actor, stay, "ENTRY.FOLLOW_ENDED", { fromEntryId: stay.followsEntryId, cause });
}

export type FollowOutcome = { following: boolean; changed: string[]; notes: string[]; shortfall: FollowShortfall | null };

/**
 * Bring a stay in line with the stay it follows. What has not changed since the last copy is left
 * alone; a room type that cannot be copied leaves the rooms as they are and is kept to be asked about.
 */
export async function syncFollower(prisma: PrismaClient, actor: Actor, stayId: string, seen: Set<string> = new Set()): Promise<FollowOutcome> {
  const none: FollowOutcome = { following: false, changed: [], notes: [], shortfall: null };
  let stay = await loadStay(prisma, stayId);
  if (!stay?.followsEntryId || ENDED.has(stay.status)) return none;
  const source = await loadStay(prisma, stay.followsEntryId);
  if (!source || source.inquiryId !== stay.inquiryId) {
    await endFollowing(prisma, actor, stay, "FIRST_STAY_GONE");
    return none;
  }
  if (ENDED.has(source.status)) {
    await endFollowing(prisma, actor, stay, "FIRST_STAY_ENDED");
    return none;
  }
  const passId = stay.segments[0]?.id ?? null;
  if (stay.quotations.some((q) => q.segmentId === passId && LIVE_QUOTE.has(q.state))) {
    await endFollowing(prisma, actor, stay, "PRICED");
    return none;
  }
  if (stay.currentStage !== "S1") {
    await endFollowing(prisma, actor, stay, "MOVED_ON");
    return none;
  }

  const state = stateOf(stay);
  const next: FollowState = { ...state };
  const changed: string[] = [];
  const notes: string[] = [];
  const { typeOf, numberOf } = await roomLookup(prisma);

  // ---- the guests, the rooms asked for, the bed ask, the kind of stay, who is arriving ----------
  if (partyCanon(source) !== partyCanon(stay)) {
    try {
      await updateEntryIntakeFields(prisma, stay.id, actor.actorId, actor.actorLevel, {
        adultCount: source.adultCount ?? undefined,
        childCount: source.childCount ?? undefined,
        childAges: source.childAges ?? [],
        guestCount: source.guestCount ?? undefined,
        numberOfRooms: source.numberOfRooms ?? undefined,
        bedTypeRequest: (source.bedTypeRequest as Record<string, number> | null) ?? null,
        useType: source.useType ?? undefined,
        contactPersonName: source.contactPersonName ?? undefined,
        contactPersonPhone: source.contactPersonPhone ?? undefined,
        contactPersonEmail: source.contactPersonEmail ?? undefined,
      });
      changed.push("guests");
    } catch (e) {
      notes.push(`The guests could not be copied: ${e instanceof Error ? e.message : "refused"}`);
    }
  }

  // ---- the guest staying --------------------------------------------------------------------------
  if (source.guestProfileId && source.guestProfileId !== stay.guestProfileId) {
    try {
      await setEntryGuest(prisma, { actorId: actor.actorId, level: actor.actorLevel }, stay.id, { mode: "EXISTING", guestProfileId: source.guestProfileId });
      changed.push("guest staying");
    } catch (e) {
      notes.push(`The guest staying could not be copied: ${e instanceof Error ? e.message : "refused"}`);
    }
  }

  // ---- the package each room type is on (2026-11-13) ------------------------------------------------
  // Copied when the stay it follows changes it; one chosen on this stay stands until then.
  const packagesCanon = JSON.stringify(source.ratePackageByRoomType ?? null);
  if (state.packagesCanon !== packagesCanon) {
    if (JSON.stringify(stay.ratePackageByRoomType ?? null) !== packagesCanon) {
      await prisma.entry.update({
        where: { id: stay.id },
        data: { ratePackageByRoomType: (source.ratePackageByRoomType ?? Prisma.DbNull) as Prisma.InputJsonValue },
      });
      changed.push("packages");
    }
    next.packagesCanon = packagesCanon;
  }

  // ---- the rooms by type ---------------------------------------------------------------------------
  const current: Stay = (await loadStay(prisma, stayId))!;
  stay = current;
  const asked = roomsAsked(source, typeOf);
  const nights = nightsOf(current);
  if (asked && nights.length > 0) {
    const canon = JSON.stringify({ mix: asked.mix, fixed: asked.fixed, stay: [nights[0], nights.length], rooms: current.numberOfRooms });
    if (canon !== state.roomsCanon || (state.shortfall && state.shortfall.key === canon)) {
      const perNight = nights.map((date, i) => ({ date, types: asked.mix[Math.min(i, asked.mix.length - 1)] }));
      const plan = (fixedRoomIds: string[]) =>
        planRoomsByTypeForStay(prisma, current.id, {
          checkInDate: nights[0],
          checkOutDate: ymdUtc(current.checkOutDate!),
          numberOfRooms: current.numberOfRooms ?? 0,
          perNight,
          fixedRoomIds,
        });
      let fixedRoomIds = asked.fixed;
      let answer = await plan(fixedRoomIds);
      if (!answer.fits && fixedRoomIds.length > 0) {
        const byTypeOnly = await plan([]);
        if (byTypeOnly.fits) {
          const named = fixedRoomIds.map((r) => numberOf.get(r)).join(", ");
          notes.push(`${fixedRoomIds.length === 1 ? `Room ${named} is` : `Rooms ${named} are`} not free on these nights — the system keeps another room of the same type.`);
          fixedRoomIds = [];
          answer = byTypeOnly;
        }
      }
      if (answer.fits) {
        await saveRooms(prisma, actor, current, perNight, fixedRoomIds);
        next.roomsCanon = canon;
        next.shortfall = null;
        changed.push("rooms");
      } else {
        if (state.shortfall?.key !== canon) await trace(prisma, actor, current, "ENTRY.FOLLOW_ROOMS_SHORT", { fromEntryId: source.id, refusals: answer.refusals });
        next.shortfall = { key: canon, refusals: answer.refusals, wanted: wantedOf(asked.mix) };
      }
    }
  }

  // ---- the table: guests per room, meals, extra beds, rates, the discount, the bed plan -----------
  const latest: Stay = (await loadStay(prisma, stayId))!;
  const sourcePass = source.segments[0]?.id ?? null;
  const operative = sourcePass ? resolveOperativeQuotation(source.quotations as never[], sourcePass) : null;
  const terms = ((operative as { commercialTerms?: unknown } | null)?.commercialTerms ?? null) as { roomCompositions?: TableRow[]; requestedDiscount?: unknown } | null;
  const sourceRows = Array.isArray(terms?.roomCompositions) ? terms!.roomCompositions! : [];
  const stayRooms = realRooms(bookingRoomsOf(latest, typeOf));
  const data: Prisma.EntryUpdateInput = {};
  if (sourceRows.length > 0 && stayRooms.length > 0) {
    const canon = JSON.stringify({ rows: sourceRows, discount: terms?.requestedDiscount ?? null, beds: source.bedPlan ?? null, rooms: stayRooms.map((r) => r.roomId) });
    if (canon !== state.tableCanon) {
      const mapped = mapTableToStay({
        rows: sourceRows,
        typeOfSourceRoom: (id) => typeOf.get(id),
        stayRooms,
        sourceNights: nightsOf(source),
        stayNights: nightsOf(latest),
      });
      data.carryOver = {
        fromEntryId: source.id,
        fromInquiryId: source.inquiryId,
        at: new Date().toISOString(),
        by: actor.actorId,
        reason: `Same as ${source.id}`,
        target: "SAME_ENQUIRY",
        rooms: [],
        compositions: mapped.rows,
        discount: terms?.requestedDiscount ?? null,
        billingModel: null,
        cancellation: null,
        guestAgreedNote: null,
      } as unknown as Prisma.InputJsonValue;
      const planned = (source.bedPlan ?? null) as Record<string, string> | null;
      if (planned) {
        const roomsHere = await prisma.room.findMany({
          where: { id: { in: mapped.pairs.map(([, to]) => to) } },
          select: { id: true, allowedBedTypes: true, roomType: { select: { allowedBedTypes: true } } },
        });
        const beds: Record<string, string> = {};
        for (const [from, to] of mapped.pairs) {
          const room = roomsHere.find((r) => r.id === to);
          const allowed = room ? (effectiveAllowedBedTypes(room.allowedBedTypes as never, room.roomType?.allowedBedTypes as never) as string[]) : [];
          if (planned[from] && allowed.includes(planned[from])) beds[to] = planned[from];
        }
        if (Object.keys(beds).length) data.bedPlan = beds as Prisma.InputJsonValue;
      }
      next.tableCanon = canon;
      changed.push("meals and table");
    }
  }

  next.notes = notes;
  await prisma.entry.update({
    where: { id: latest.id },
    data: { ...data, followState: next as unknown as Prisma.InputJsonValue, ...(data.carryOver ? { version: { increment: 1 } } : {}) },
  });
  if (changed.length > 0) {
    await trace(prisma, actor, latest, "ENTRY.FOLLOW_APPLIED", { fromEntryId: source.id, changed, notes });
    await syncFollowersOf(prisma, actor, latest.id, seen);
  }
  return { following: true, changed, notes, shortfall: next.shortfall ?? null };
}

/** Bring every stay that follows this one in line. One that cannot be never refuses the save that caused it. */
export async function syncFollowersOf(prisma: PrismaClient, actor: Actor, sourceId: string, seen: Set<string> = new Set()): Promise<void> {
  if (seen.has(sourceId)) return;
  seen.add(sourceId);
  const followers = await prisma.entry.findMany({
    where: { followsEntryId: sourceId, status: { in: ["ACTIVE", "PARKED"] } },
    select: { id: true, inquiryId: true },
  });
  for (const f of followers) {
    try {
      await syncFollower(prisma, actor, f.id, seen);
    } catch (e) {
      await trace(prisma, actor, f, "ENTRY.FOLLOW_FAILED", { fromEntryId: sourceId, message: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    }
  }
}

export type StayChange = "INTAKE" | "ROOMS" | "GUEST" | "PRICED" | "BEDS" | "AMENDED";

/**
 * Called by the routes after a person's save on a stay — never by the copying itself. A stay changed
 * by hand goes its own way; a stay that others follow passes the change on. Never throws: the save
 * has already happened.
 */
export async function afterStayChanged(prisma: PrismaClient, actor: Actor, entryId: string, kind: StayChange): Promise<void> {
  try {
    const e = await loadStay(prisma, entryId);
    if (!e) return;
    if (e.followsEntryId) {
      if (kind === "PRICED") await endFollowing(prisma, actor, e, "PRICED");
      else if (kind === "ROOMS") await endFollowing(prisma, actor, e, "ROOMS_CHOSEN_HERE");
      else if (kind === "AMENDED") await endFollowing(prisma, actor, e, "CHANGED_HERE");
      else if (kind === "GUEST") {
        const source = await loadStay(prisma, e.followsEntryId);
        if (source?.guestProfileId !== e.guestProfileId) await endFollowing(prisma, actor, e, "GUEST_NAMED_HERE");
      } else if (kind === "INTAKE") {
        const source = await loadStay(prisma, e.followsEntryId);
        // Its own dates may move and it still follows; its guests may not.
        if (source && partyCanon(source) !== partyCanon(e)) await endFollowing(prisma, actor, e, "CHANGED_HERE");
        else await syncFollower(prisma, actor, entryId);
      }
    }
    await syncFollowersOf(prisma, actor, entryId);
  } catch (err) {
    console.error("[trip-follow] after a change on", entryId, err);
  }
}

/** Opening a stay looks again at rooms that were not free when it last tried. Never throws. */
export async function retryFollowerOnOpen(prisma: PrismaClient, actor: Actor, stayId: string): Promise<void> {
  try {
    await syncFollower(prisma, actor, stayId);
  } catch (err) {
    console.error("[trip-follow] on opening", stayId, err);
  }
}

/** "Same as this stay": the new stay follows the one named, and is brought in line now. */
export async function startFollowing(prisma: PrismaClient, actor: Actor, stayId: string, fromEntryId: string) {
  const stay = await loadStay(prisma, stayId);
  if (!stay) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: stay.status });
  if (stay.id === fromEntryId) throw new ValidationError("A stay cannot be the same as itself");
  if (stay.currentStage !== "S1") throw new ValidationError("A stay is set up the same as another only while it is at Inquiry");
  const source = await loadStay(prisma, fromEntryId);
  if (!source) throw new NotFoundError("Entry");
  if (source.inquiryId !== stay.inquiryId) throw new ValidationError(`${source.id} is not a stay of this trip`);
  enforceEntryNotSealedForWorkingAction({ status: source.status });
  // A stay cannot be followed in a ring.
  let walker: string | null = source.followsEntryId;
  for (let i = 0; walker && i < 20; i++) {
    if (walker === stay.id) throw new ValidationError(`${source.id} already follows this stay`);
    walker = (await prisma.entry.findUnique({ where: { id: walker }, select: { followsEntryId: true } }))?.followsEntryId ?? null;
  }
  // Asked again for the same stay, it keeps what it copied: nothing is copied twice.
  if (stay.followsEntryId !== source.id) {
    await prisma.entry.update({ where: { id: stay.id }, data: { followsEntryId: source.id, sameSetupAs: source.id, followState: {} as Prisma.InputJsonValue } });
    await trace(prisma, actor, stay, "ENTRY.FOLLOW_STARTED", { fromEntryId: source.id });
  }
  const outcome = await syncFollower(prisma, actor, stay.id);
  return {
    following: outcome.following,
    changed: outcome.changed,
    notes: outcome.notes,
    shortfall: outcome.shortfall ? await shortfallView(prisma, stay.id, outcome.shortfall) : null,
  };
}

/** "Set its own" — the stay stops copying and keeps what it has. */
export async function stopFollowing(prisma: PrismaClient, actor: Actor, stayId: string) {
  const stay = await loadStay(prisma, stayId);
  if (!stay) throw new NotFoundError("Entry");
  if (!stay.followsEntryId) throw new ValidationError("This stay's settings are already its own");
  await endFollowing(prisma, actor, stay, "SET_ITS_OWN");
  await prisma.entry.update({ where: { id: stay.id }, data: { sameSetupAs: null } });
  return { following: false };
}

/** The room types the desk chose for a stay whose first stay's rooms were not free on its nights. */
export async function chooseFollowerRooms(prisma: PrismaClient, actor: Actor, stayId: string, types: TypeCount[]) {
  const stay = await loadStay(prisma, stayId);
  if (!stay) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: stay.status });
  if (!stay.followsEntryId) throw new ValidationError("This stay's rooms are its own now — choose them on its Inquiry step");
  if (stay.currentStage !== "S1") throw new ValidationError("Rooms are chosen this way only while the stay is at Inquiry");
  const nights = nightsOf(stay);
  const perNight = nights.map((date) => ({ date, types }));
  const answer = await planRoomsByTypeForStay(prisma, stay.id, {
    checkInDate: nights[0],
    checkOutDate: ymdUtc(stay.checkOutDate!),
    numberOfRooms: stay.numberOfRooms ?? 0,
    perNight,
  });
  if (!answer.fits) throw new ValidationError(answer.refusals[0] ?? "Those rooms cannot be kept for this stay");
  await saveRooms(prisma, actor, stay, perNight, []);
  // What the desk chose answers what the first stay asks now: not asked again until that changes.
  const state = stateOf(stay);
  await prisma.entry.update({
    where: { id: stay.id },
    data: { followState: { ...state, roomsCanon: state.shortfall?.key ?? state.roomsCanon, shortfall: null } as unknown as Prisma.InputJsonValue },
  });
  await trace(prisma, actor, stay, "ENTRY.FOLLOW_ROOMS_CHOSEN", { fromEntryId: stay.followsEntryId, types });
  await syncFollower(prisma, actor, stay.id);
  return { saved: true };
}

export type FollowShortfallView = {
  refusals: string[];
  key: string;
  rooms: number;
  currency: string;
  wanted: Array<{ roomTypeId: string; name: string; count: number; canTake: number }>;
  /** Every room type, with the whole stays it can still take on these nights. */
  types: Array<{ roomTypeId: string; name: string; free: number; ratePerNight: number | null }>;
};

async function shortfallView(prisma: PrismaClient, stayId: string, shortfall: FollowShortfall): Promise<FollowShortfallView> {
  const stay = await prisma.entry.findUniqueOrThrow({ where: { id: stayId }, select: { numberOfRooms: true } });
  const house = await answerHouseByType(prisma, stayId);
  const { firstOfType } = await roomLookup(prisma);
  const ref = await buildEntryRateReference(prisma, stayId, { planRoomIds: [...firstOfType.values()] }).catch(() => null);
  const rateOf = (id: string) => {
    const r = ref?.roomTypes.find((x) => x.roomTypeId === id)?.roomRate;
    return r == null ? null : Number(r);
  };
  const free = new Map(house.types.map((t) => [t.roomTypeId, t.wholeStay] as const));
  const nameOf = new Map(house.types.map((t) => [t.roomTypeId, t.name] as const));
  return {
    refusals: shortfall.refusals,
    key: shortfall.key,
    rooms: stay.numberOfRooms ?? 0,
    currency: ref?.currency ?? "BTN",
    wanted: shortfall.wanted.map((w) => ({ ...w, name: nameOf.get(w.roomTypeId) ?? "Room", canTake: Math.min(w.count, free.get(w.roomTypeId) ?? 0) })),
    types: house.types
      .map((t) => ({ roomTypeId: t.roomTypeId, name: t.name, free: t.wholeStay, ratePerNight: rateOf(t.roomTypeId) }))
      .sort((a, b) => Number(b.free > 0) - Number(a.free > 0) || a.name.localeCompare(b.name)),
  };
}

export type FollowView = {
  entryId: string;
  fromEntryId: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  /** Its guests and rooms still follow — only while it is at Inquiry. */
  roomsFollow: boolean;
  notes: string[];
  shortfall: FollowShortfallView | null;
};

/** What this stay follows, and which stays follow it. Read-only. */
export async function readTripFollow(prisma: PrismaClient, entryId: string): Promise<{ following: FollowView | null; followers: FollowView[] }> {
  const fields = { id: true, followsEntryId: true, followState: true, checkInDate: true, checkOutDate: true, currentStage: true } as const;
  const e = await prisma.entry.findUnique({ where: { id: entryId }, select: fields });
  if (!e) throw new NotFoundError("Entry");
  const view = async (s: NonNullable<typeof e>): Promise<FollowView> => {
    const state = stateOf(s);
    return {
      entryId: s.id,
      fromEntryId: s.followsEntryId!,
      checkInDate: s.checkInDate ? ymdUtc(s.checkInDate) : null,
      checkOutDate: s.checkOutDate ? ymdUtc(s.checkOutDate) : null,
      roomsFollow: s.currentStage === "S1",
      notes: state.notes ?? [],
      shortfall: state.shortfall ? await shortfallView(prisma, s.id, state.shortfall) : null,
    };
  };
  const followers = await prisma.entry.findMany({
    where: { followsEntryId: entryId, status: { in: ["ACTIVE", "PARKED"] } },
    orderBy: { checkInDate: "asc" },
    select: fields,
  });
  return { following: e.followsEntryId ? await view(e) : null, followers: await Promise.all(followers.map(view)) };
}
