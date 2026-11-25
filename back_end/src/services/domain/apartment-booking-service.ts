/**
 * Apartments on a booking (2026-11-25, operator: "the house section will only show the room types
 * listed there in the apartment section and also rooms listed there only"; "in the stay section show
 * option to choose monthly or weekly plan … on the right hand side, show the packages of weekly and
 * monthly rate both").
 *
 * A booking whose kind of stay is Apartment picks whole apartments — a 2 BHK's rooms together — from
 * the packages on the admin console. The pick is recorded as any pick is (`selectOption`, every night
 * of the stay, the apartments' rooms by number), and the booking's room count follows the apartments.
 * What each package would come to for the stay is the rent rule's (lib/apartment-rent.ts), server
 * figures only.
 */
import { Stage, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { plansForStay, rentForStay, ymdOf, type ApartmentPlan } from "../../lib/apartment-rent.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { apartmentRateFigures } from "../admin/apartment-admin-service.js";
import { queryAvailability, selectOption } from "./s1-availability-service.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import * as auditService from "../infrastructure/audit-service.js";
import type { ApartmentOfRoom } from "../../policies/13-billing-model/p33-apartment-commercial-fields-s1-exit.js";

type Level = "L1" | "L2" | "L3" | "L4";
const DAY = 86_400_000;

export type ApartmentInfo = ApartmentOfRoom & {
  unitId: string;
  maxOccupants: number;
  packageId: string;
  packageName: string;
  packageActive: boolean;
};

/** Each room's apartment, for the rooms given (rooms in no apartment are left out). */
export async function apartmentsOfRooms(prisma: PrismaClient, roomIds: string[]): Promise<Map<string, ApartmentInfo>> {
  const out = new Map<string, ApartmentInfo>();
  if (!roomIds.length) return out;
  const links = await prisma.apartmentUnitRoom.findMany({
    where: { roomId: { in: roomIds } },
    select: {
      roomId: true,
      unit: {
        select: {
          id: true,
          label: true,
          maxOccupants: true,
          package: { select: { id: true, name: true, isActive: true } },
          rooms: { select: { roomId: true, room: { select: { roomNumber: true } } } },
        },
      },
    },
  });
  for (const l of links) {
    const rooms = [...l.unit.rooms].sort((a, b) => a.room.roomNumber.localeCompare(b.room.roomNumber, undefined, { numeric: true }));
    out.set(l.roomId, {
      unitId: l.unit.id,
      label: l.unit.label,
      maxOccupants: l.unit.maxOccupants,
      packageId: l.unit.package.id,
      packageName: l.unit.package.name,
      packageActive: l.unit.package.isActive,
      roomIds: rooms.map((r) => r.roomId),
      roomNumbers: rooms.map((r) => r.room.roomNumber),
    });
  }
  return out;
}

/** The rooms a pick holds, with their numbers and apartments — what Policy 33 reads at the S1 exit. */
export async function apartmentRoomsOfPick(prisma: PrismaClient, optionSelected: unknown) {
  const ids = readOptionSelected(optionSelected).distinctRoomIds;
  const rooms = await prisma.room.findMany({ where: { id: { in: ids } }, select: { id: true, roomNumber: true } });
  return {
    pickedRooms: rooms.map((r) => ({ roomId: r.id, roomNumber: r.roomNumber })),
    apartmentOf: await apartmentsOfRooms(prisma, ids),
  };
}

/** The pick on the booking's own pass, at Inquiry (not sealed yet) or after. */
async function currentPick(prisma: PrismaClient, entryId: string) {
  const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" }, select: { id: true } });
  const cfg = await prisma.availabilityConfiguration.findFirst({
    where: { entryId, optionSelected: { not: { equals: null } } as never, ...(seg ? { OR: [{ segmentId: seg.id }, { segmentId: null }] } : {}) },
    orderBy: { createdAt: "desc" },
    select: { optionSelected: true },
  });
  return new Set(readOptionSelected(cfg?.optionSelected ?? null).distinctRoomIds);
}

/**
 * Every apartment offered, for this booking's stay (or the dates given, not saved yet): free or not,
 * picked or not, and what each package comes to under each plan the stay may take.
 */
export async function describeApartmentsForEntry(
  prisma: PrismaClient,
  entryId: string,
  stay?: { checkInDate?: string | null; checkOutDate?: string | null },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, useType: true, apartmentPlan: true, checkInDate: true, checkOutDate: true, adultCount: true, childCount: true, guestCount: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const ci = stay?.checkInDate ? new Date(`${stay.checkInDate.slice(0, 10)}T00:00:00Z`) : entry.checkInDate;
  const co = stay?.checkOutDate ? new Date(`${stay.checkOutDate.slice(0, 10)}T00:00:00Z`) : entry.checkOutDate;
  const rule = await resolveChargeRates(prisma);
  const packages = await prisma.apartmentPackage.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      units: {
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
        include: { rooms: { include: { room: { select: { id: true, roomNumber: true, bedType: true, isBlocked: true, blockedReason: true, isUnderMaintenance: true, maintenanceDeadline: true, isDeficient: true, roomType: { select: { name: true } } } } } } },
      },
    },
  });
  const allRoomIds = packages.flatMap((p) => p.units.flatMap((u) => u.rooms.map((r) => r.roomId)));
  const dated = !!ci && !!co && co.getTime() > ci.getTime();
  const conflicts = dated ? await findRoomBookingConflicts(prisma, { roomIds: allRoomIds, checkIn: ci!, checkOut: co!, excludeEntryId: entryId }) : [];
  const conflictsOf = new Map<string, typeof conflicts>();
  for (const c of conflicts) conflictsOf.set(c.roomId, [...(conflictsOf.get(c.roomId) ?? []), c]);
  const picked = await currentPick(prisma, entryId);
  const plans = dated ? plansForStay(ci!, co!) : null;
  const guests = entry.guestCount ?? (entry.adultCount ?? 0) + (entry.childCount ?? 0);

  return {
    entryId,
    useType: String(entry.useType),
    plan: (entry.apartmentPlan as ApartmentPlan | null) ?? null,
    stay: dated ? { checkInDate: ymdOf(ci!), checkOutDate: ymdOf(co!), nights: plans!.nights } : null,
    plans: plans ? { monthly: plans.monthly, weekly: plans.weekly, firstMonthEnds: plans.firstMonthEnds, firstWeekEnds: plans.firstWeekEnds } : null,
    guests,
    serviceChargeRate: rule.serviceChargeRate,
    gstRate: rule.gstRate,
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      carpetAreaSqft: p.carpetAreaSqft,
      amenities: p.amenities,
      weekly: apartmentRateFigures(p.weeklyRate, rule),
      monthly: apartmentRateFigures(p.monthlyRate, rule),
      forStay: plans
        ? {
            MONTHLY: plans.monthly ? rentForStay({ plan: "MONTHLY", checkIn: ci!, checkOut: co!, weeklyRate: p.weeklyRate, monthlyRate: p.monthlyRate, rule }) : null,
            WEEKLY: plans.weekly ? rentForStay({ plan: "WEEKLY", checkIn: ci!, checkOut: co!, weeklyRate: p.weeklyRate, monthlyRate: p.monthlyRate, rule }) : null,
          }
        : null,
      units: p.units.map((u) => {
        const rooms = [...u.rooms].sort((a, b) => a.room.roomNumber.localeCompare(b.room.roomNumber, undefined, { numeric: true }));
        const takenBy = rooms.flatMap((r) =>
          (conflictsOf.get(r.roomId) ?? []).map((c) => ({
            roomNumber: r.room.roomNumber,
            entryId: c.entryId,
            guestName: c.guestName,
            from: ymdOf(c.startDate),
            to: ymdOf(c.endDate),
            kind: c.source === "RESERVED" ? "RESERVED" : c.holdKind === "SPECULATIVE" ? "MARKED" : "HELD",
          })),
        );
        const outOfService = dated
          ? rooms.flatMap((r) => {
              if (r.room.isBlocked) return [`Room ${r.room.roomNumber} is blocked${r.room.blockedReason ? ` — ${r.room.blockedReason}` : ""}`];
              const d = r.room.maintenanceDeadline;
              if (r.room.isUnderMaintenance && d && d.getTime() >= ci!.getTime() && d.getTime() <= co!.getTime())
                return [`Room ${r.room.roomNumber} is under maintenance until ${ymdOf(d)}`];
              return [];
            })
          : [];
        return {
          id: u.id,
          label: u.label,
          maxOccupants: u.maxOccupants,
          rooms: rooms.map((r) => ({ id: r.roomId, roomNumber: r.room.roomNumber, bedType: r.room.bedType, roomTypeName: r.room.roomType.name, faultOpen: r.room.isDeficient })),
          free: dated && !takenBy.length && !outOfService.length,
          takenBy,
          outOfService,
          picked: rooms.length > 0 && rooms.every((r) => picked.has(r.roomId)),
        };
      }),
    })),
  };
}

/** Save the apartments picked: every night of the stay, their rooms by number. Inquiry only. */
export async function pickApartmentsForEntry(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: Level },
  input: { unitIds: string[] },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, status: true, currentStage: true, useType: true, inquiryId: true, checkInDate: true, checkOutDate: true, adultCount: true, childCount: true, guestCount: true, numberOfRooms: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (entry.currentStage !== Stage.S1) throw new ValidationError("The apartments are chosen on the Inquiry step");
  if (String(entry.useType) !== "APARTMENT") throw new ValidationError("This booking is not an apartment stay — set the kind of stay to Apartment first");
  if (!entry.checkInDate || !entry.checkOutDate) throw new ValidationError("Set the stay's dates first");
  const unitIds = [...new Set((input.unitIds ?? []).map(String))];
  if (!unitIds.length) throw new ValidationError("Pick at least one apartment");

  const units = await prisma.apartmentUnit.findMany({
    where: { id: { in: unitIds } },
    include: { package: { select: { name: true, isActive: true } }, rooms: { include: { room: { select: { id: true, roomNumber: true, isDeficient: true } } } } },
  });
  if (units.length !== unitIds.length) throw new ValidationError("An apartment picked is no longer on the admin console — ask the house again");
  for (const u of units) {
    if (!u.package.isActive) throw new ValidationError(`${u.package.name} is no longer offered`);
    if (!u.rooms.length) throw new ValidationError(`Apartment ${u.label} has no room on the admin console`);
  }
  const guests = entry.guestCount ?? (entry.adultCount ?? 0) + (entry.childCount ?? 0);
  const room = units.reduce((n, u) => n + u.maxOccupants, 0);
  if (guests > room) {
    throw new ValidationError(
      `${units.length === 1 ? `Apartment ${units[0].label} takes` : `These ${units.length} apartments take`} at most ${room} guest${room === 1 ? "" : "s"}; this booking has ${guests}`,
    );
  }

  const rooms = units
    .flatMap((u) => u.rooms.map((r) => r.room))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  const roomIds = rooms.map((r) => r.id);
  const nights: string[] = [];
  for (let t = entry.checkInDate.getTime(); t < entry.checkOutDate.getTime(); t += DAY) nights.push(ymdOf(new Date(t)));
  const perNight = nights.map((date) => ({ date, roomIds }));
  const deficient = rooms.filter((r) => r.isDeficient);
  const acks = deficient.length
    ? deficient.map((r) => ({ roomId: r.id, acknowledgedAt: new Date().toISOString(), note: "Acknowledged when the apartment was chosen at Inquiry" }))
    : undefined;

  // A fresh answer from the house for exactly this stay, then the pick: proved first, written after
  // the room count follows the apartments.
  const search = await queryAvailability(prisma, entryId, actor.actorId, actor.actorLevel as never, {
    checkInDate: ymdOf(entry.checkInDate),
    checkOutDate: ymdOf(entry.checkOutDate),
    guestCount: guests || undefined,
  });
  const configId = (search as { configuration: { id: string } }).configuration.id;
  await selectOption(prisma, configId, actor.actorId, { perNight, deficientAcknowledgements: acks }, {
    validateOnly: true,
    stay: { checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate, numberOfRooms: roomIds.length },
  });
  if (entry.numberOfRooms !== roomIds.length) {
    await prisma.entry.update({ where: { id: entryId }, data: { numberOfRooms: roomIds.length, version: { increment: 1 } } });
  }
  await selectOption(prisma, configId, actor.actorId, { perNight, deficientAcknowledgements: acks });

  const labels = units.map((u) => u.label).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  await auditService.emit(prisma as never, { actorId: actor.actorId, actorLevel: actor.actorLevel as never }, {
    eventType: "ENTRY.APARTMENTS_PICKED",
    entityType: "Entry",
    entityId: entryId,
    operation: "UPDATE",
    timestamp: new Date(),
    stageContext: Stage.S1,
    inquiryId: entry.inquiryId,
    entryId,
    payload: {
      apartments: units.map((u) => ({ label: u.label, package: u.package.name, rooms: u.rooms.map((r) => r.room.roomNumber).sort() })),
      rooms: rooms.map((r) => r.roomNumber),
      numberOfRooms: roomIds.length,
    },
  } as never);
  return { apartments: labels, rooms: rooms.map((r) => r.roomNumber), numberOfRooms: roomIds.length, configurationId: configId };
}
