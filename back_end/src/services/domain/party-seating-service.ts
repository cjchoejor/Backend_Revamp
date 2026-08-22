import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import {
  assessPartySeating,
  currentPerNightPicture,
  derivePartySlots,
  repairPartySeating,
  repointStrayRows,
  resolveCompositionBasis,
  successorChainFromConfigs,
  type CompositionBasisSource,
  type PartyBand,
  type SeatingRow,
} from "../../lib/party-seating.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { changeRoomToNewSegment, type RoomChangeOutcome } from "./room-change-service.js";

/**
 * Party seating, as a service (2026-08-21, operator ruling — "when a room is changed make sure
 * occupants are assigned properly, no room is empty and everyone has a room; if it doesn't,
 * inform the user and make it assign").
 *
 * Two doors, both backend-authoritative so the production frontend gets the identical rule:
 *   - `buildPartySeatingStatus` — the server-computed truth: who sleeps where on the booking's
 *     CURRENT composition basis, who has no room, which plan rooms are empty, and whether a
 *     repair is possible from here;
 *   - `repairPartySeatingForEntry` — restores both invariants through the governed room-change
 *     journey (setup-only form: nobody moves; new segment, silent re-quote with everyone seated,
 *     re-freeze, back to the origin stage), so the repaired seating becomes the booking's frozen
 *     commercial terms rather than a desk-side guess.
 */

export type PartySeatingStatus = {
  entryId: string;
  currentStage: string;
  /** False when the booking carries no per-room composition anywhere — nothing to seat. */
  hasComposition: boolean;
  source: CompositionBasisSource;
  /** Both invariants hold (vacuously true with no composition). */
  ok: boolean;
  party: Array<{
    key: string;
    label: string;
    band: PartyBand;
    /** Every room this guest sleeps in (primary first); empty = no room. */
    rooms: Array<{ roomId: string; roomNumber: string | null }>;
  }>;
  unseated: Array<{ key: string; label: string }>;
  /** Plan rooms whose composition counts nobody (includes rooms with no row at all). */
  emptyRooms: Array<{ roomId: string; roomNumber: string | null; hasRow: boolean }>;
  /** Composition rows naming a room the plan no longer holds — re-pointable on repair. */
  strayRooms: Array<{ roomId: string; roomNumber: string | null }>;
  perNight: Array<{ date: string; shortfall: Record<PartyBand, number>; overflow: Record<PartyBand, number> }>;
  /** A repair can run from here (S5–S7, ACTIVE, a composition to seat with, something to fix). */
  repairable: boolean;
  repairBlockedReason: string | null;
  /** The room the repair would be anchored on (the setup-only form needs a from-room). */
  suggestedFromRoomId: string | null;
};

async function loadSeatingEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      adultCount: true,
      childAges: true,
      guestCount: true,
      checkInDate: true,
      checkOutDate: true,
      segments: { orderBy: { segmentNumber: "desc" }, select: { id: true } },
      quotations: {
        orderBy: { createdAt: "desc" },
        select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true },
      },
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true, frozenCommercialTerms: true } },
      reservations: { orderBy: { confirmedAt: "desc" }, select: { confirmedAt: true, frozenCommercialTerms: true } },
      committedHold: { select: { roomId: true, perNightBreakdown: true } },
      roomAssignments: { orderBy: { createdAt: "desc" }, select: { roomId: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "asc" },
        select: { optionSelected: true },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

const DAY_MS = 86_400_000;
function isoNightsBetween(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  const start = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  const end = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  for (let t = start; t < end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function heldRooms(hold: { roomId: string | null; perNightBreakdown: Prisma.JsonValue | null } | null): string[] {
  if (!hold) return [];
  const out = new Set<string>();
  if (hold.roomId) out.add(hold.roomId);
  if (Array.isArray(hold.perNightBreakdown)) {
    for (const night of hold.perNightBreakdown as Array<{ roomIds?: Array<{ roomId?: string }> }>) {
      for (const r of night?.roomIds ?? []) if (typeof r?.roomId === "string") out.add(r.roomId);
    }
  }
  return [...out];
}

export async function buildPartySeatingStatus(prisma: PrismaClient, entryId: string): Promise<PartySeatingStatus> {
  const entry = await loadSeatingEntry(prisma, entryId);
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const slots = derivePartySlots(entry, {
    youngChildMaxAge: bundle?.ageBands.youngChildMaxAge ?? 5,
    childMaxAge: bundle?.ageBands.childMaxAge ?? 10,
  });
  const basis = resolveCompositionBasis<SeatingRow>(entry);

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const checkOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  const nightsIso = checkIn && checkOut ? isoNightsBetween(checkIn, checkOut) : [];
  const latestSealed = entry.availabilityConfigs[entry.availabilityConfigs.length - 1] ?? null;
  const picture = currentPerNightPicture({
    sealedOption: latestSealed?.optionSelected ?? null,
    fallbackRoomIds: Array.from(new Set([...heldRooms(entry.committedHold), ...entry.roomAssignments.map((a) => a.roomId)])),
    nightsIso: nightsIso.length > 0 ? nightsIso : ["stay"],
  });
  const planRoomIds = Array.from(new Set(picture.flatMap((n) => n.roomIds)));

  const rows = basis.compositions ?? [];
  const strayRooms = rows.map((r) => r.roomId).filter((id) => !planRoomIds.includes(id));
  const assessment = assessPartySeating({ slots, rows, picture });

  const roomRows = await prisma.room.findMany({
    where: { id: { in: Array.from(new Set([...planRoomIds, ...strayRooms])) } },
    select: { id: true, roomNumber: true },
  });
  const numberOf = new Map(roomRows.map((r) => [r.id, r.roomNumber]));
  const room = (id: string) => ({ roomId: id, roomNumber: numberOf.get(id) ?? null });

  const hasComposition = rows.length > 0;
  const ok = !hasComposition ? true : assessment.ok && strayRooms.length === 0;

  // Would a repair change anything, and which room would it touch? (Dry — pure.)
  let suggestedFromRoomId: string | null = null;
  let repairBlockedReason: string | null = null;
  if (!hasComposition) repairBlockedReason = "This booking has no per-room composition — occupants and meals are set up through a fresh quote";
  else if (entry.status !== "ACTIVE") repairBlockedReason = `The booking is ${entry.status.toLowerCase()} — its record is read-only`;
  else if (!([Stage.S5, Stage.S6, Stage.S7] as Stage[]).includes(entry.currentStage)) {
    repairBlockedReason = "Seating is repaired from Arrival, Check-in or Stay — earlier, regenerate the quote on the Quote step";
  } else if (ok) repairBlockedReason = "Every guest already has a room and no room is empty";
  else {
    const successorOf = successorChainFromConfigs(entry.availabilityConfigs);
    const repointed = repointStrayRows(rows, planRoomIds, successorOf);
    const dry = repairPartySeating({ slots, rows: repointed.rows, picture });
    const touched = new Set<string>([
      ...repointed.actions.flatMap((a) => (a.type === "ROW_REPOINTED" ? [a.toRoomId] : [])),
      ...dry.actions.flatMap((a) => ("roomId" in a ? [a.roomId] : [])),
    ]);
    const todayIso = new Date().toISOString().slice(0, 10);
    // In-house the setup-only form needs a room with nights LEFT (the change runs from tonight);
    // prefer a room the repair touches, then the room with the most remaining nights.
    const remaining = (id: string) =>
      picture.filter((n) => n.roomIds.includes(id) && (entry.currentStage === Stage.S7 ? n.date >= todayIso : true)).length;
    const candidates = planRoomIds.filter((id) => remaining(id) > 0).sort((a, b) => {
      const ta = touched.has(a) ? 0 : 1;
      const tb = touched.has(b) ? 0 : 1;
      return ta - tb || remaining(b) - remaining(a) || planRoomIds.indexOf(a) - planRoomIds.indexOf(b);
    });
    suggestedFromRoomId = candidates[0] ?? null;
    if (!suggestedFromRoomId) repairBlockedReason = "The stay has no nights left to re-seat";
  }

  return {
    entryId: entry.id,
    currentStage: String(entry.currentStage),
    hasComposition,
    source: basis.source,
    ok,
    party: slots.map((s) => ({
      key: s.key,
      label: s.label,
      band: s.band,
      rooms: (assessment.seating.get(s.key) ?? []).map(room),
    })),
    unseated: assessment.unseated.map((s) => ({ key: s.key, label: s.label })),
    emptyRooms: hasComposition
      ? assessment.emptyRooms.map((id) => ({ ...room(id), hasRow: !assessment.roomsWithoutRow.includes(id) }))
      : [],
    strayRooms: strayRooms.map(room),
    perNight: hasComposition
      ? assessment.perNight.map((n) => ({ date: n.date, shortfall: n.shortfall, overflow: n.overflow }))
      : [],
    repairable: repairBlockedReason == null && suggestedFromRoomId != null,
    repairBlockedReason,
    suggestedFromRoomId,
  };
}

/**
 * Seat every guest and fill every empty room — through the governed room-change journey in its
 * setup-only form (nobody moves rooms). Refused, entry untouched, when there is nothing to
 * repair or the booking is not at S5–S7. Returns the room-change outcome; `seating.lines` say
 * exactly who was seated where.
 */
export async function repairPartySeatingForEntry(
  prisma: PrismaClient,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  entryId: string,
  reason?: string | null,
): Promise<RoomChangeOutcome> {
  const status = await buildPartySeatingStatus(prisma, entryId);
  if (!status.repairable || !status.suggestedFromRoomId) {
    throw new ValidationError(status.repairBlockedReason ?? "The seating cannot be repaired from here");
  }
  return changeRoomToNewSegment(prisma, actor, {
    entryId,
    fromRoomId: status.suggestedFromRoomId,
    reason: reason?.trim() || "Seat every guest in a room",
    repairSeating: true,
  });
}
