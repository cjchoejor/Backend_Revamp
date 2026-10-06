/**
 * Which room this booking wants made up as what.
 *
 * The guest's ask at intake (`Entry.bedTypeRequest`) is a TALLY — "2 Queen and 1 King" — with no
 * rooms in it, and until now nothing carried it to a room: the only control that set a bed was
 * the registry dropdown at Arrival, which the desk had to drive from memory (2026-10-06,
 * operator: "say guest said 2 queen and 1 king, where do we assign those bed types in s2? I don't
 * think we have them right").
 *
 * **The plan is the booking's, the setup is the room's.** `Entry.bedPlan` says what this stay
 * wants each of its rooms made up as; `Room.bedType` is how a room is made up right now. They are
 * deliberately separate: a booking three weeks out must not change the beds under tonight's
 * guest, and the registry holds one current setup per room with no dates in it. So a choice made
 * at Negotiation is recorded and nothing else; from **Arrival**, where the room is this booking's
 * to prepare, the same choice also makes the room up that way — exactly what the old per-room
 * dropdown did, which this replaces.
 *
 * It is **not** part of the quotation. A bed setup carries no price (the EXTRA bed does, and that
 * is a composition field), so putting it in `commercialTerms` would freeze it at Reserve and make
 * "make 202 a twin instead" a whole new pass through the stages. It is a plain booking fact,
 * editable at any live step by the desk (L1).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import {
  ROOM_BED_TYPES,
  type RoomBedType,
  assertBedTypeAllowedForRoom,
  checkBedRequestAgainstRooms,
  effectiveAllowedBedTypes,
  normaliseBedType,
  setRoomBedType,
  usualBedTypeFor,
} from "./room-bed-type-service.js";

export interface BedPlanRoom {
  roomId: string;
  roomNumber: string;
  roomTypeName: string | null;
  /** What this stay wants it made up as. */
  bedType: RoomBedType | null;
  /** Where that came from: the desk said so / shared out from the guest's ask / the usual setup. */
  source: "PLAN" | "ASK" | "USUAL";
  usual: RoomBedType | null;
  allowed: RoomBedType[];
  /** How the room is made up right now. */
  roomNow: RoomBedType | null;
  /** The room is this booking's to prepare, so a choice here is carried out at once. */
  appliesNow: boolean;
}

export interface EntryBedPlan {
  rooms: BedPlanRoom[];
  /** The guest's own ask, as a tally — null when they expressed none. */
  ask: Record<string, number> | null;
  /** Every asked setup could be given a room of its own. */
  askSatisfiable: boolean;
  /** Why it could not be, in desk words. */
  message: string | null;
}

/** From Arrival on, the room is the booking's to make up; before that it belongs to the house. */
const APPLIES_FROM: ReadonlySet<string> = new Set(["S5", "S6", "S7"]);

type EntryForPlan = {
  id: string;
  currentStage: string;
  bedTypeRequest: unknown;
  bedPlan: unknown;
  roomAssignments: { roomId: string }[];
  availabilityConfigs: { optionSelected: unknown; sealedAt: Date | null }[];
  committedHold: { roomId: string | null; perNightBreakdown: unknown } | null;
};

const entryForPlanSelect = {
  id: true,
  currentStage: true,
  bedTypeRequest: true,
  bedPlan: true,
  roomAssignments: { select: { roomId: true } },
  availabilityConfigs: { select: { optionSelected: true, sealedAt: true }, orderBy: { createdAt: "desc" as const } },
  committedHold: { select: { roomId: true, perNightBreakdown: true } },
};

/** Every room the booking has ever named — what a bed may be planned for. */
function roomsEverHeld(entry: EntryForPlan): Set<string> {
  const out = new Set<string>();
  for (const a of entry.roomAssignments) out.add(a.roomId);
  for (const c of entry.availabilityConfigs) {
    if (!c.sealedAt) continue;
    for (const id of readOptionSelected(c.optionSelected).distinctRoomIds) out.add(id);
  }
  if (entry.committedHold?.roomId) out.add(entry.committedHold.roomId);
  const nights = (entry.committedHold?.perNightBreakdown as { roomIds?: { roomId?: string }[] }[] | null) ?? [];
  for (const n of nights) {
    for (const r of n.roomIds ?? []) if (r.roomId) out.add(r.roomId);
  }
  return out;
}

/** The rooms the plan names now — assignments first, else the sealed pick, else the hold. */
function currentPlanRoomIds(entry: EntryForPlan): string[] {
  const assigned = Array.from(new Set(entry.roomAssignments.map((a) => a.roomId)));
  if (assigned.length) return assigned;
  const sealed = entry.availabilityConfigs.find((c) => c.sealedAt && c.optionSelected);
  const fromSeal = sealed ? readOptionSelected(sealed.optionSelected).distinctRoomIds : [];
  if (fromSeal.length) return fromSeal;
  return entry.committedHold?.roomId ? [entry.committedHold.roomId] : [];
}

function readStoredPlan(value: unknown): Record<string, RoomBedType> {
  const out: Record<string, RoomBedType> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [roomId, raw] of Object.entries(value as Record<string, unknown>)) {
    const t = normaliseBedType(typeof raw === "string" ? raw : null);
    if (t) out[roomId] = t;
  }
  return out;
}

function readAsk(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [raw, n] of Object.entries(value as Record<string, unknown>)) {
    const t = normaliseBedType(raw);
    const count = Number(n);
    if (t && Number.isFinite(count) && count > 0) out[t] = Math.floor(count);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The guest's tally, shared out over the rooms — by the same matching that answers whether the
 * ask can be met at all, so what the desk is shown is what the check approved. Rooms are taken in
 * number order, so the seeding reads the same on every load.
 */
export function shareAskAcrossRooms(
  ask: Record<string, number> | null,
  rooms: readonly { roomId: string; roomNumber: string; allowed: RoomBedType[] }[],
): { seeded: Record<string, RoomBedType>; satisfiable: boolean; message: string | null } {
  if (!ask) return { seeded: {}, satisfiable: true, message: null };
  const ordered = [...rooms].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  const check = checkBedRequestAgainstRooms(
    ask,
    ordered.map((r) => ({ id: r.roomId, roomNumber: r.roomNumber, allowed: r.allowed })),
  );
  return { seeded: check.assignment, satisfiable: check.satisfiable, message: check.message };
}

export async function buildEntryBedPlan(prisma: PrismaClient, entryId: string): Promise<EntryBedPlan> {
  const entry = (await prisma.entry.findUnique({
    where: { id: entryId },
    select: entryForPlanSelect,
  })) as EntryForPlan | null;
  if (!entry) throw new NotFoundError("Entry");

  const ids = currentPlanRoomIds(entry);
  const ask = readAsk(entry.bedTypeRequest);
  if (ids.length === 0) return { rooms: [], ask, askSatisfiable: true, message: null };

  const rows = await prisma.room.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      roomNumber: true,
      bedType: true,
      allowedBedTypes: true,
      defaultBedType: true,
      roomType: { select: { name: true, allowedBedTypes: true, defaultBedType: true } },
    },
  });
  const facts = rows.map((r) => ({
    roomId: r.id,
    roomNumber: r.roomNumber,
    roomTypeName: r.roomType?.name ?? null,
    allowed: effectiveAllowedBedTypes(r.allowedBedTypes, r.roomType?.allowedBedTypes ?? []),
    usual: usualBedTypeFor(r.defaultBedType, r.roomType?.defaultBedType ?? null),
    roomNow: normaliseBedType(r.bedType),
  }));

  const plan = readStoredPlan(entry.bedPlan);
  const { seeded, satisfiable, message } = shareAskAcrossRooms(ask, facts);
  const assigned = new Set(entry.roomAssignments.map((a) => a.roomId));
  const appliesStage = APPLIES_FROM.has(entry.currentStage);

  const rooms: BedPlanRoom[] = facts
    .map((f) => {
      const chosen = plan[f.roomId] ?? null;
      const fromAsk = seeded[f.roomId] ?? null;
      const source: BedPlanRoom["source"] = chosen ? "PLAN" : fromAsk ? "ASK" : "USUAL";
      return {
        ...f,
        bedType: chosen ?? fromAsk ?? f.usual,
        source,
        appliesNow: appliesStage && assigned.has(f.roomId),
      };
    })
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));

  return { rooms, ask, askSatisfiable: satisfiable, message };
}

/**
 * Say what one room should be made up as for this stay. `bedType: null` hands it back to the ask
 * (or to the room's usual setup, when the guest asked for nothing).
 */
export async function setEntryBedPlanRoom(
  prisma: PrismaClient,
  entryId: string,
  input: { roomId: string; bedType: string | null },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
): Promise<EntryBedPlan & { applied: boolean; appliedNote: string | null }> {
  const entry = (await prisma.entry.findUnique({
    where: { id: entryId },
    select: { ...entryForPlanSelect, status: true },
  })) as (EntryForPlan & { status: string }) | null;
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status as never });

  const roomId = input.roomId?.trim();
  if (!roomId) throw new ValidationError("roomId is required");
  if (!roomsEverHeld(entry).has(roomId)) {
    throw new ValidationError("That room is not part of this booking — a bed setup is planned for the rooms it holds");
  }

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      id: true,
      roomNumber: true,
      allowedBedTypes: true,
      defaultBedType: true,
      roomType: { select: { allowedBedTypes: true, defaultBedType: true } },
    },
  });
  if (!room) throw new NotFoundError("Room");

  const plan = readStoredPlan(entry.bedPlan);
  const before = plan[roomId] ?? null;
  let bedType: RoomBedType | null = null;
  if (input.bedType === null || input.bedType === "") {
    delete plan[roomId];
  } else {
    bedType = normaliseBedType(input.bedType);
    if (!bedType) throw new ValidationError(`bedType must be one of: ${ROOM_BED_TYPES.join(", ")}`);
    assertBedTypeAllowedForRoom(
      room.roomNumber,
      bedType,
      effectiveAllowedBedTypes(room.allowedBedTypes, room.roomType?.allowedBedTypes ?? []),
    );
    plan[roomId] = bedType;
  }

  await prisma.$transaction(async (tx) => {
    await tx.entry.update({
      where: { id: entryId },
      data: { bedPlan: Object.keys(plan).length ? plan : Prisma.DbNull },
    });
    await tx.traceEvent.create({
      data: {
        eventType: bedType ? "ENTRY.BED_PLAN_SET" : "ENTRY.BED_PLAN_CLEARED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Entry",
        entityId: entryId,
        entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: entry.currentStage as never,
        payload: { roomId, roomNumber: room.roomNumber, from: before, to: bedType },
        createdBy: actor.actorId,
      },
    });
  });

  // From Arrival the room is this booking's to prepare, so the choice is carried out at once —
  // the same write the old per-room dropdown made. Before that it is only recorded: the room may
  // well have someone else in it tonight.
  //
  // It is the RESOLVED setup that is carried out, not the one typed, so taking a choice back
  // puts the room onto whatever now answers for it — the guest's ask, or its usual setup —
  // instead of leaving it made up for a decision that has been withdrawn.
  let plan2 = await buildEntryBedPlan(prisma, entryId);
  let applied = false;
  let appliedNote: string | null = null;
  const row = plan2.rooms.find((r) => r.roomId === roomId);
  if (row?.appliesNow && row.bedType && row.bedType !== row.roomNow) {
    try {
      await setRoomBedType(prisma, roomId, actor, { bedType: row.bedType, entryId });
      applied = true;
      plan2 = await buildEntryBedPlan(prisma, entryId);
    } catch (e) {
      // The plan stands either way; the desk is told why the room itself did not follow.
      appliedNote = e instanceof Error ? e.message : "the room could not be made up that way";
    }
  }

  return { ...plan2, applied, appliedNote };
}

/**
 * Make the booking's rooms up as planned, as they become its own (room assignment at Arrival).
 * Best-effort and quiet: a room that cannot take the setup, or that is being prepared for someone
 * else, is left as it is — the desk reads the difference on the rooms table.
 */
export async function applyBedPlanToAssignedRooms(
  entryId: string,
  actorId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  try {
    const plan = await buildEntryBedPlan(prisma, entryId);
    for (const r of plan.rooms) {
      if (!r.appliesNow || !r.bedType || r.bedType === r.roomNow) continue;
      await setRoomBedType(prisma, r.roomId, { actorId, actorLevel: "L1" }, { bedType: r.bedType, entryId }).catch(
        () => undefined,
      );
    }
  } catch {
    /* the beds stay the desk's to set if this could not run */
  }
}
