/**
 * Moving between the stays of one trip (2026-10-06, operator: "suppose an inquiry has a return
 * stay, and they are on stay 1 doing some stages ... the user has to constantly switch between
 * stays, and it keeps asking if I want to park or not while switching — can it not ask that,
 * maybe from the backend it can park it on its own while switching, with a reason like
 * 'switching stays to make configurations'").
 *
 * Leaving a booking at Inquiry or Negotiation offers to park it, because those two steps run a
 * clock that lapses the lead if nobody comes back. Between the stays of one trip the desk is not
 * leaving — it is working the same enquiry in two places — so the question is answered for it:
 *
 *  - **The stay being left is parked**, with that reason, when it is ACTIVE at Inquiry or
 *    Negotiation (the only places the prompt ever asked). Anywhere else nothing happens: no clock
 *    there would lapse it, and a park would only add a Resume to press.
 *  - **The stay being opened is resumed — but only when a switch parked it.** The park this act
 *    writes carries `cause: "TRIP_SWITCH"` on its `ENTRY.PARKED` trace, and only that park is
 *    undone here; a booking a person parked on purpose stays parked until a person resumes it.
 *
 * Both halves go through the ordinary `parkEntry` / `unparkEntry`, so every park gate, the
 * 30-day follow-up clock, the dwell mode and the trace are exactly what a hand park writes. They
 * are two outcomes, reported separately: a refused resume never undoes the park, and the desk
 * moves to the other stay whatever happened.
 */
import { EntryStatus, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parkEntry, unparkEntry } from "./s1-entry-service.js";

/** The operator's own words for the park a switch makes. */
export const TRIP_SWITCH_PARK_REASON = "Switching stays to make configurations";
export const TRIP_SWITCH_CAUSE = "TRIP_SWITCH";

/** The two steps whose clock lapses a lead — the ones the leave-prompt has always asked about. */
const PARKS_ON_SWITCH: ReadonlySet<string> = new Set(["S1", "S2"]);

export type TripSwitchOutcome = {
  fromEntryId: string;
  toEntryId: string;
  /** The stay left behind was parked by this switch. */
  parked: boolean;
  /** The stay opened was resumed, because an earlier switch had parked it. */
  resumed: boolean;
  /** The opened stay is parked and stays so — a person parked it, not a switch. */
  stillParked: boolean;
  /** Why the park or the resume could not be done, when one was attempted and refused. */
  parkRefused: string | null;
  resumeRefused: string | null;
};

/** Was this booking's current park made by a trip switch? Read off its latest park trace. */
export async function parkedByTripSwitch(prisma: PrismaClient, entryId: string): Promise<boolean> {
  const last = await prisma.traceEvent.findFirst({
    where: { entryId, eventType: "ENTRY.PARKED" },
    orderBy: { timestamp: "desc" },
    select: { payload: true },
  });
  const payload = (last?.payload ?? null) as { cause?: unknown } | null;
  return payload?.cause === TRIP_SWITCH_CAUSE;
}

export async function switchStay(
  prisma: PrismaClient,
  fromEntryId: string,
  toEntryId: string,
  actorId: string,
): Promise<TripSwitchOutcome> {
  if (fromEntryId === toEntryId) throw new ValidationError("That is the stay already open.");
  const [from, to] = await Promise.all([
    prisma.entry.findUnique({ where: { id: fromEntryId }, select: { id: true, inquiryId: true, status: true, currentStage: true } }),
    prisma.entry.findUnique({ where: { id: toEntryId }, select: { id: true, inquiryId: true, status: true, currentStage: true } }),
  ]);
  if (!from) throw new NotFoundError("Entry");
  if (!to) throw new NotFoundError("Entry");
  if (from.inquiryId !== to.inquiryId) {
    throw new ValidationError(`${to.id} is not a stay of this trip — open it from the bookings list instead.`);
  }

  const out: TripSwitchOutcome = {
    fromEntryId,
    toEntryId,
    parked: false,
    resumed: false,
    stillParked: false,
    parkRefused: null,
    resumeRefused: null,
  };

  if (from.status === EntryStatus.ACTIVE && PARKS_ON_SWITCH.has(from.currentStage)) {
    try {
      await parkEntry(prisma, from.id, actorId, `${TRIP_SWITCH_PARK_REASON} — moved to ${to.id}`, {
        cause: TRIP_SWITCH_CAUSE,
        switchedTo: to.id,
      });
      out.parked = true;
    } catch (e) {
      out.parkRefused = e instanceof Error ? e.message : "it could not be parked";
    }
  }

  if (to.status === EntryStatus.PARKED) {
    if (await parkedByTripSwitch(prisma, to.id)) {
      try {
        await unparkEntry(prisma, to.id, actorId, { cause: TRIP_SWITCH_CAUSE, switchedFrom: from.id });
        out.resumed = true;
      } catch (e) {
        out.resumeRefused = e instanceof Error ? e.message : "it could not be resumed";
        out.stillParked = true;
      }
    } else {
      out.stillParked = true;
    }
  }

  return out;
}
