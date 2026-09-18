import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import {
  armNoShowCutoff,
  isTimeOfDay,
  noShowCutoffFor,
  resolveExpectedArrival,
  resolveNoShowGraceMinutes,
  resolveStandardCheckInTime,
} from "../../lib/expected-arrival.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

/**
 * A booking's expected arrival and its no-show cut-off (2026-09-18) — read, and set by the desk.
 *
 * The time is recorded from Inquiry to Arrival (S1–S5); once the guest is checked in there is
 * nothing left for it to decide. At Arrival a new time re-arms the cut-off. Once the cut-off has
 * been REACHED, a new time is recorded but the cut-off is not reopened: bringing a no-show
 * candidate back is the FOM's reactivation (SIG-S5 sub-path 3), not a side effect of typing a time.
 */

const EDITABLE: Stage[] = [Stage.S1, Stage.S2, Stage.S3, Stage.S4, Stage.S5];

async function load(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: { select: { frozenCheckInDate: true } }, noShowDetermination: { select: { id: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

export async function getExpectedArrival(prisma: PrismaClient, entryId: string) {
  const entry = await load(prisma, entryId);
  const expected = await resolveExpectedArrival(prisma, entry);
  const graceMinutes = await resolveNoShowGraceMinutes(prisma).catch(() => null);
  // The clock that is running — or, once the cut-off has been reached, the one that fired, so the
  // desk states the cut-off that actually applied rather than re-planning it from now.
  const clock = await prisma.timerRecord.findFirst({
    where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", status: entry.noShowCutoffReachedAt ? { in: ["SCHEDULED", "FIRED"] } : "SCHEDULED" },
    orderBy: { createdAt: "desc" },
    select: { dueAt: true },
  });
  return {
    entryId,
    /** "HH:MM" hotel-local; the guest's own when set, else the hotel's standard check-in time. */
    time: expected.time,
    source: expected.source,
    /** The guest's own time as recorded (null = none given). */
    guestTime: isTimeOfDay(entry.expectedArrivalTime) ? entry.expectedArrivalTime : null,
    standardTime: await resolveStandardCheckInTime(prisma),
    at: expected.at?.toISOString() ?? null,
    graceMinutes,
    /** When the cut-off would fall if the clock were set now (planned, whatever the clock). */
    cutoffAt: expected.at && graceMinutes != null ? noShowCutoffFor(expected.at, graceMinutes).toISOString() : null,
    /** The cut-off clock (Arrival onward): the running one, or the one that fired once reached. */
    cutoffClockAt: clock?.dueAt.toISOString() ?? null,
    cutoffReachedAt: entry.noShowCutoffReachedAt?.toISOString() ?? null,
    editable: EDITABLE.includes(entry.currentStage) && (entry.status === "ACTIVE" || entry.status === "PARKED"),
  };
}

export async function setExpectedArrival(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: string,
  time: string | null,
) {
  if (time !== null && !isTimeOfDay(time)) throw new ValidationError("The arrival time must be a 24-hour time, HH:MM");
  const entry = await load(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (!EDITABLE.includes(entry.currentStage)) {
    throw new StateTransitionError("The guest is already checked in — an expected arrival time no longer applies", "ARRIVAL_TIME_AFTER_CHECK_IN");
  }

  const before = isTimeOfDay(entry.expectedArrivalTime) ? entry.expectedArrivalTime : null;
  await prisma.entry.update({ where: { id: entryId }, data: { expectedArrivalTime: time, version: { increment: 1 } } });
  await prisma.traceEvent.create({
    data: {
      eventType: "ENTRY.EXPECTED_ARRIVAL_SET",
      actorId,
      actorLevel: actorLevel as never,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { from: before, to: time },
      createdBy: actorId,
    },
  });

  // At Arrival the cut-off follows the new time — unless it has already been reached.
  let rearmedAt: string | null = null;
  const reached = !!entry.noShowCutoffReachedAt;
  if (entry.currentStage === Stage.S5 && !entry.noShowDetermination && !reached) {
    const expected = await resolveExpectedArrival(prisma, { ...entry, expectedArrivalTime: time });
    const grace = await resolveNoShowGraceMinutes(prisma);
    if (expected.at) {
      const cutoffAt = noShowCutoffFor(expected.at, grace);
      await armNoShowCutoff(prisma, entryId, cutoffAt, actorId);
      rearmedAt = cutoffAt.toISOString();
    }
  }
  return {
    ...(await getExpectedArrival(prisma, entryId)),
    rearmedAt,
    cutoffAlreadyReached: reached,
  };
}
