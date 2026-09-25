/**
 * A return stay — "we'll stay on the way out, then again on the way back" (2026-09-25, operator
 * ruling after the Thimphu-and-back scenario).
 *
 * The guest leaves and comes back, so the two stays are genuinely two bookings: each holds its
 * own rooms for its own nights, is checked in and out on its own, and — the operator's choice of
 * the three options offered — **keeps its own folio, its own bill and its own tax invoice**. The
 * room in between must stay sellable, and a tax invoice covers one stay.
 *
 * What the link buys is everything around the money: both stays hang off the SAME Inquiry, so
 * the enquiry number is the trip's file number, the agency / company / rate package / notes are
 * shared by construction (they live on the inquiry), and each booking can show the other. The
 * desk never has to find the guest twice, which is also what stops a second guest record being
 * typed by mistake.
 *
 * Nothing new is stored: `Inquiry.entries` has always been a list. This service is the governed
 * way to add to it, and `createEntry` does the actual work, so a return stay is validated,
 * classified and timed exactly like any other booking.
 */
import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
import * as auditService from "../infrastructure/audit-service.js";
import { createEntry } from "./s1-entry-service.js";

const dayMs = 24 * 60 * 60 * 1000;

function parseStayDate(value: string, field: string): Date {
  const d = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a date`);
  return d;
}

/** "25 Sep - 26 Sep" for a refusal that names the stay it clashes with; the house's month names. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function spanWords(from: Date | null, to: Date | null): string {
  const w = (d: Date | null) => (d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : "—");
  return `${w(from)} – ${w(to)}`;
}

export interface AddReturnStayInput {
  checkInDate: string;
  checkOutDate: string;
  /** Carried from the first stay when omitted — the same party coming back. */
  numberOfRooms?: number;
  adultCount?: number;
  childCount?: number;
  childAges?: number[];
}

/**
 * Add the guest's return stay to the same enquiry as `sourceEntryId`.
 *
 * Refused before anything is written when: the first booking is sealed (cancelled, expired or
 * closed — that trip is over, so the next visit is a fresh enquiry), the dates are back to front,
 * the return is in the past, or it overlaps a stay already on this enquiry (which is a duplicate,
 * not a return).
 */
export async function addReturnStay(
  prisma: PrismaClient,
  sourceEntryId: string,
  actor: { actorId: string; actorLevel: ActorLevel },
  input: AddReturnStayInput,
) {
  const source = await prisma.entry.findUnique({
    where: { id: sourceEntryId },
    include: {
      inquiry: {
        select: {
          id: true,
          entries: {
            select: { id: true, checkInDate: true, checkOutDate: true, status: true },
            orderBy: { checkInDate: "asc" },
          },
        },
      },
    },
  });
  if (!source) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: source.status });

  const checkIn = parseStayDate(input.checkInDate, "checkInDate");
  const checkOut = parseStayDate(input.checkOutDate, "checkOutDate");
  if (checkOut.getTime() <= checkIn.getTime()) {
    throw new ValidationError("The return stay's check-out must be after its check-in");
  }
  const today = hotelTodayUtc();
  if (checkIn.getTime() < today.getTime()) {
    throw new ValidationError(`A return stay starts today (${ymdUtc(today)}) or later`);
  }

  // A stay that shares a night with one already on this enquiry is the same stay entered twice.
  for (const sibling of source.inquiry.entries) {
    if (sibling.status === "CANCELLED" || sibling.status === "EXPIRED") continue;
    const sIn = sibling.checkInDate;
    const sOut = sibling.checkOutDate ?? (sIn ? new Date(sIn.getTime() + dayMs) : null);
    if (!sIn || !sOut) continue;
    if (sIn.getTime() < checkOut.getTime() && sOut.getTime() > checkIn.getTime()) {
      throw new ValidationError(
        `This enquiry already has a stay over those nights (${sibling.id} · ${spanWords(sIn, sOut)}) — a return stay is for the nights after the guest comes back`,
      );
    }
  }

  const created = await createEntry(prisma, actor.actorId, actor.actorLevel, {
    inquiryId: source.inquiry.id,
    guestProfileId: source.guestProfileId ?? undefined,
    useType: source.useType,
    checkInDate: input.checkInDate.slice(0, 10),
    checkOutDate: input.checkOutDate.slice(0, 10),
    // The same party comes back unless the desk says otherwise.
    adultCount: input.adultCount ?? source.adultCount ?? undefined,
    childCount: input.childCount ?? source.childCount ?? undefined,
    childAges: input.childAges ?? (input.childCount == null ? source.childAges : undefined),
    guestCount:
      input.adultCount != null || input.childCount != null
        ? (input.adultCount ?? source.adultCount ?? 0) + (input.childCount ?? source.childCount ?? 0)
        : (source.guestCount ?? undefined),
    numberOfRooms: input.numberOfRooms ?? source.numberOfRooms ?? undefined,
    otaSource: source.otaSource ?? undefined,
    contactPersonName: source.contactPersonName ?? undefined,
    contactPersonPhone: source.contactPersonPhone ?? undefined,
    contactPersonEmail: source.contactPersonEmail ?? undefined,
  });

  // Both bookings carry the link, so either one opened alone says the trip has another stay.
  await auditService.emit(prisma, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.RETURN_STAY_ADDED",
    entityType: "Entry",
    entityId: source.id,
    operation: "CREATE",
    timestamp: new Date(),
    inquiryId: source.inquiry.id,
    entryId: source.id,
    payload: { returnStayEntryId: created.id, checkInDate: input.checkInDate, checkOutDate: input.checkOutDate },
  });
  await auditService.emit(prisma, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.CREATED_AS_RETURN_STAY",
    entityType: "Entry",
    entityId: created.id,
    operation: "CREATE",
    timestamp: new Date(),
    inquiryId: source.inquiry.id,
    entryId: created.id,
    payload: { fromEntryId: source.id },
  });

  return created;
}
