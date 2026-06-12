/**
 * RateCard admin service — append-only versioned per party. Same pattern as ConfigurationEntry:
 * editing produces a new row with a new `effectiveFrom`; the prior row gets `effectiveTo` set.
 * Historical bookings always look up the rate card active at the time they were quoted.
 *
 * Per-room-type overrides (`RoomTypeRateOverride`) are tied to a specific RateCard row. When a
 * new RateCard version is created, the active overrides from the prior version are automatically
 * copied forward — admin only needs to re-adjust the ones that changed.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { PartyType } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { allocateReadableId } from "../../lib/readable-id.js";

type DecimalInput = number | string;

export type RateCardInput = {
  partyType: PartyType;
  partyId: string;
  roomBaseRate: DecimalInput;
  extraBedRate?: DecimalInput | null;
  cnbPercent?: number | null; // 0-100
  breakfastRate?: DecimalInput | null;
  lunchRate?: DecimalInput | null;
  dinnerRate?: DecimalInput | null;
  cpRate?: DecimalInput | null;
  mapLunchRate?: DecimalInput | null;
  mapDinnerRate?: DecimalInput | null;
  apRate?: DecimalInput | null;
  currency?: string;
  notes?: string | null;
};

export type RoomTypeRateOverrideInput = {
  roomTypeId: string;
  roomBaseRate: DecimalInput;
  notes?: string | null;
};

/* ----------------------- Internal helpers -------------------------------- */

function toDecimalOrNull(v: DecimalInput | null | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`rate must be a non-negative number, got ${v}`);
  return n.toFixed(2);
}

function toDecimalRequired(v: DecimalInput, label: string): string {
  const out = toDecimalOrNull(v);
  if (out === null) throw new ValidationError(`${label} is required`);
  return out;
}

async function verifyPartyExists(prisma: PrismaClient, partyType: PartyType, partyId: string): Promise<void> {
  if (!partyId?.trim()) throw new ValidationError("partyId is required");
  if (partyType === PartyType.TRAVEL_AGENT) {
    const found = await prisma.travelAgent.findUnique({ where: { id: partyId } });
    if (!found) throw new ValidationError(`TravelAgent ${partyId} not found`);
  } else if (partyType === PartyType.CORPORATE) {
    const found = await prisma.corporateAccount.findUnique({ where: { id: partyId } });
    if (!found) throw new ValidationError(`CorporateAccount ${partyId} not found`);
  } else {
    throw new ValidationError(`Unknown partyType: ${partyType}`);
  }
}

/* ----------------------- Read APIs -------------------------------------- */

/** All rate cards (active + historical) for a party, newest first. */
export async function listRateCardsForParty(prisma: PrismaClient, partyType: PartyType, partyId: string) {
  return prisma.rateCard.findMany({
    where: { partyType, partyId },
    orderBy: { effectiveFrom: "desc" },
    include: { overrides: { include: { roomType: true } } },
  });
}

/** The currently-active rate card for a party (or null if none). */
export async function getActiveRateCard(
  prisma: PrismaClient,
  partyType: PartyType,
  partyId: string,
  asOf: Date = new Date(),
) {
  return prisma.rateCard.findFirst({
    where: {
      partyType,
      partyId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { overrides: { include: { roomType: true } } },
  });
}

/* ----------------------- Write APIs ------------------------------------- */

/**
 * Create a new RateCard version for a party. If a card is currently active, it gets closed
 * (`effectiveTo = now`) and its active room-type overrides are copied forward to the new card.
 *
 * Admin clients use this for both "first-time set the rate" and "edit the rate" — there is
 * no in-place edit. To change one field, call this with the full payload.
 */
export async function createRateCardVersion(prisma: PrismaClient, input: RateCardInput, actorId: string) {
  await verifyPartyExists(prisma, input.partyType, input.partyId);
  const roomBaseRate = toDecimalRequired(input.roomBaseRate, "roomBaseRate");
  if (input.cnbPercent != null) {
    if (!Number.isInteger(input.cnbPercent) || input.cnbPercent < 0 || input.cnbPercent > 100) {
      throw new ValidationError("cnbPercent must be an integer 0-100");
    }
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const prior = await tx.rateCard.findFirst({
      where: {
        partyType: input.partyType,
        partyId: input.partyId,
        effectiveTo: null,
      },
      include: { overrides: true },
      orderBy: { effectiveFrom: "desc" },
    });

    if (prior) {
      await tx.rateCard.update({ where: { id: prior.id }, data: { effectiveTo: now } });
    }

    const id = await allocateReadableId(tx, "RATE_CARD" as const, now);
    const created = await tx.rateCard.create({
      data: {
        id,
        partyType: input.partyType,
        partyId: input.partyId,
        roomBaseRate,
        extraBedRate: toDecimalOrNull(input.extraBedRate),
        cnbPercent: input.cnbPercent ?? null,
        breakfastRate: toDecimalOrNull(input.breakfastRate),
        lunchRate: toDecimalOrNull(input.lunchRate),
        dinnerRate: toDecimalOrNull(input.dinnerRate),
        cpRate: toDecimalOrNull(input.cpRate),
        mapLunchRate: toDecimalOrNull(input.mapLunchRate),
        mapDinnerRate: toDecimalOrNull(input.mapDinnerRate),
        apRate: toDecimalOrNull(input.apRate),
        currency: input.currency?.trim() || "BTN",
        effectiveFrom: now,
        notes: input.notes?.trim() || null,
        createdBy: actorId,
      },
    });

    // Carry forward prior overrides.
    if (prior && prior.overrides.length > 0) {
      await tx.roomTypeRateOverride.createMany({
        data: prior.overrides.map((o) => ({
          rateCardId: created.id,
          roomTypeId: o.roomTypeId,
          roomBaseRate: o.roomBaseRate,
          notes: o.notes,
          createdBy: actorId,
        })),
      });
    }

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.RATE_CARD_VERSION_CREATED",
      entityType: "RateCard",
      entityId: created.id,
      operation: "CREATE",
      payload: {
        partyType: input.partyType,
        partyId: input.partyId,
        priorRateCardId: prior?.id ?? null,
        overrideCopyCount: prior?.overrides.length ?? 0,
      },
    });

    return tx.rateCard.findUnique({
      where: { id: created.id },
      include: { overrides: { include: { roomType: true } } },
    });
  });
}

/* ----------------------- Room-type overrides ---------------------------- */

/** Add a room-type override on an EXISTING active rate card. Idempotent via unique(rateCard, roomType). */
export async function setRoomTypeRateOverride(
  prisma: PrismaClient,
  rateCardId: string,
  input: RoomTypeRateOverrideInput,
  actorId: string,
) {
  const card = await prisma.rateCard.findUnique({ where: { id: rateCardId } });
  if (!card) throw new NotFoundError("RateCard");
  if (card.effectiveTo != null) throw new ValidationError("Cannot modify overrides on a superseded rate card");

  const room = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!room) throw new ValidationError(`RoomType ${input.roomTypeId} not found`);

  const rate = toDecimalRequired(input.roomBaseRate, "roomBaseRate");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.roomTypeRateOverride.findUnique({
      where: { rateCardId_roomTypeId: { rateCardId, roomTypeId: input.roomTypeId } },
    });
    let row;
    if (existing) {
      row = await tx.roomTypeRateOverride.update({
        where: { id: existing.id },
        data: { roomBaseRate: rate, notes: input.notes?.trim() || null },
      });
    } else {
      row = await tx.roomTypeRateOverride.create({
        data: {
          rateCardId,
          roomTypeId: input.roomTypeId,
          roomBaseRate: rate,
          notes: input.notes?.trim() || null,
          createdBy: actorId,
        },
      });
    }
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: existing ? "ADMIN.ROOM_TYPE_RATE_OVERRIDE_UPDATED" : "ADMIN.ROOM_TYPE_RATE_OVERRIDE_CREATED",
      entityType: "RoomTypeRateOverride",
      entityId: row.id,
      operation: existing ? "UPDATE" : "CREATE",
      payload: { rateCardId, roomTypeId: input.roomTypeId },
    });
    return row;
  });
}

export async function deleteRoomTypeRateOverride(prisma: PrismaClient, overrideId: string, actorId: string) {
  const existing = await prisma.roomTypeRateOverride.findUnique({ where: { id: overrideId }, include: { rateCard: true } });
  if (!existing) throw new NotFoundError("RoomTypeRateOverride");
  if (existing.rateCard.effectiveTo != null) {
    throw new ValidationError("Cannot delete an override on a superseded rate card");
  }
  return prisma.$transaction(async (tx) => {
    await tx.roomTypeRateOverride.delete({ where: { id: overrideId } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_TYPE_RATE_OVERRIDE_DELETED",
      entityType: "RoomTypeRateOverride",
      entityId: overrideId,
      operation: "DELETE",
      payload: { rateCardId: existing.rateCardId, roomTypeId: existing.roomTypeId },
    });
    return { ok: true } as const;
  });
}
