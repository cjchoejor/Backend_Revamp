import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import {
  armNoShowCutoff,
  isTimeOfDay,
  noShowCutoffFor,
  resolveExpectedArrival,
  resolveNextMorningLatest,
  resolveNoShowGraceMinutes,
  resolveStandardCheckInTime,
} from "../../lib/expected-arrival.js";
import { addUtcDays, hotelCalendarYmd, hotelClockHm, hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15:00" -> "3:00 PM". */
function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
/** "2026-10-29" -> "29 Oct". */
function dayWords(ymd: string): string {
  const [, m, d] = ymd.split("-").map((x) => Number(x));
  return `${d} ${MONTHS[m - 1]}`;
}

/**
 * The earliest a guest may be expected (2026-10-29, operator: "it shouldn't let the time pick be
 * … 2 hrs (or the time which was set in the admin console) later than the current time — say the
 * current time is 5 pm, it should let the user pick 3 pm"): now less the no-show grace, to the
 * minute. Earlier than that the cut-off — expected arrival plus the grace — would already be
 * behind us, and the guest a no-show the moment the time was typed.
 */
function earliestExpected(graceMinutes: number, now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 - graceMinutes * 60_000);
}

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
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const earliest = graceMinutes != null ? earliestExpected(graceMinutes) : null;
  // The clock that is running — or, once the cut-off has been reached, the one that fired, so the
  // desk states the cut-off that actually applied rather than re-planning it from now.
  const clock = await prisma.timerRecord.findFirst({
    where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", status: entry.noShowCutoffReachedAt ? { in: ["SCHEDULED", "FIRED"] } : "SCHEDULED" },
    orderBy: { createdAt: "desc" },
    select: { dueAt: true },
  });
  // When the cut-off counts from (2026-10-29, operator, on a cut-off of 6:56 PM beside a 2:00 PM
  // arrival): the expected arrival — or, when the booking reached Arrival after it, that moment.
  const fromAt = clock && graceMinutes != null ? new Date(clock.dueAt.getTime() - graceMinutes * 60_000) : null;
  const cutoffFrom: "EXPECTED" | "REACHED_ARRIVAL" | null =
    !fromAt || !expected.at ? null : fromAt.getTime() - expected.at.getTime() > 60_000 ? "REACHED_ARRIVAL" : "EXPECTED";
  return {
    entryId,
    /** "HH:MM" hotel-local; the guest's own when set, else the hotel's standard check-in time. */
    time: expected.time,
    source: expected.source,
    /** The guest's own time as recorded (null = none given). */
    guestTime: isTimeOfDay(entry.expectedArrivalTime) ? entry.expectedArrivalTime : null,
    /** The guest is expected the morning after the check-in day. */
    dayAfter: expected.dayAfter,
    standardTime: await resolveStandardCheckInTime(prisma),
    /** The check-in day and the day after it, "YYYY-MM-DD". */
    checkInDate: checkIn ? ymdUtc(checkIn) : null,
    dayAfterDate: checkIn ? ymdUtc(addUtcDays(checkIn, 1)) : null,
    /** The next morning, the guest is expected before this ("HH:MM", the hotel's check-out time). */
    nextMorningLatest: await resolveNextMorningLatest(prisma),
    /**
     * Whether the desk offers the next morning: a check-in after the hotel's today (a booking
     * arriving today is asked only its time — operator), or a next morning already recorded.
     */
    offerNextMorning: expected.dayAfter || (!!checkIn && checkIn.getTime() > hotelTodayUtc().getTime()),
    /** The earliest a guest's time may be — now less the grace — as the hotel reads it. */
    earliest: earliest ? { at: earliest.toISOString(), date: hotelCalendarYmd(earliest), time: hotelClockHm(earliest) } : null,
    at: expected.at?.toISOString() ?? null,
    graceMinutes,
    /** When the cut-off would fall if the clock were set now (planned, whatever the clock). */
    cutoffAt: expected.at && graceMinutes != null ? noShowCutoffFor(expected.at, graceMinutes).toISOString() : null,
    /** The cut-off clock (Arrival onward): the running one, or the one that fired once reached. */
    cutoffClockAt: clock?.dueAt.toISOString() ?? null,
    /** What the running cut-off counts from: the expected arrival, or the moment the booking reached Arrival after it. */
    cutoffFrom,
    /** That moment, when the cut-off counts from it. */
    cutoffFromAt: cutoffFrom === "REACHED_ARRIVAL" ? fromAt!.toISOString() : null,
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
  dayAfterAsked = false,
) {
  if (time !== null && !isTimeOfDay(time)) throw new ValidationError("The arrival time must be a 24-hour time, HH:MM");
  const entry = await load(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (!EDITABLE.includes(entry.currentStage)) {
    throw new StateTransitionError("The guest is already checked in — an expected arrival time no longer applies", "ARRIVAL_TIME_AFTER_CHECK_IN");
  }
  // The next morning goes with a time of the guest's own; "the hotel's time" is the check-in day's.
  const dayAfter = time !== null && dayAfterAsked;
  const grace = await resolveNoShowGraceMinutes(prisma);
  if (time !== null) {
    if (dayAfter) {
      const latest = await resolveNextMorningLatest(prisma);
      if (time >= latest) {
        throw new ValidationError(
          `The next morning, the guest has to be expected before ${clock12(latest)} — the hotel's check-out time. Later than that the first night is missed; change the dates instead.`,
        );
      }
    }
    const asked = await resolveExpectedArrival(prisma, { ...entry, expectedArrivalTime: time, expectedArrivalDayAfter: dayAfter });
    const floor = earliestExpected(grace);
    if (asked.at && asked.at.getTime() < floor.getTime()) {
      const day = hotelCalendarYmd(asked.at);
      const earliestDay = hotelCalendarYmd(floor);
      const hours = grace % 60 === 0 ? `${grace / 60} hour${grace === 60 ? "" : "s"}` : `${grace} minutes`;
      throw new ValidationError(
        `The guest can't be expected at ${clock12(time)}${day === hotelCalendarYmd() ? "" : ` on ${dayWords(day)}`} — that is more than ${hours} ago, so the no-show cut-off would already have passed. The earliest is ${clock12(hotelClockHm(floor))}${earliestDay === day ? "" : ` on ${dayWords(earliestDay)}`}.`,
      );
    }
  }

  const before = isTimeOfDay(entry.expectedArrivalTime) ? entry.expectedArrivalTime : null;
  const dayAfterBefore = !!before && entry.expectedArrivalDayAfter;
  await prisma.entry.update({
    where: { id: entryId },
    data: { expectedArrivalTime: time, expectedArrivalDayAfter: dayAfter, version: { increment: 1 } },
  });
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
      payload: { from: before, to: time, dayAfterFrom: dayAfterBefore, dayAfterTo: dayAfter },
      createdBy: actorId,
    },
  });

  // At Arrival the cut-off follows the new time — unless it has already been reached.
  let rearmedAt: string | null = null;
  const reached = !!entry.noShowCutoffReachedAt;
  if (entry.currentStage === Stage.S5 && !entry.noShowDetermination && !reached) {
    const expected = await resolveExpectedArrival(prisma, { ...entry, expectedArrivalTime: time, expectedArrivalDayAfter: dayAfter });
    if (expected.at) {
      // The cut-off counts from the time the desk gave (2026-10-29): 5:00 PM typed at 5:47 PM is
      // 7:00 PM — it used to count from the moment of typing, and read "2 hours after it reached
      // Arrival at 5:47 PM". A time already set for this booking before keeps the cut-off it had
      // (as a return to Arrival does); the hotel's time keeps the rule Arrival applies — never
      // inside the grace of now.
      const prior = await prisma.timerRecord.findFirst({
        where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", payload: { path: ["expectedAt"], equals: expected.at.toISOString() } },
        orderBy: { createdAt: "desc" },
        select: { dueAt: true },
      });
      const cutoffAt =
        prior && prior.dueAt.getTime() >= Date.now() - 60_000
          ? prior.dueAt
          : expected.source === "GUEST"
            ? new Date(expected.at.getTime() + grace * 60_000)
            : noShowCutoffFor(expected.at, grace);
      await armNoShowCutoff(prisma, entryId, cutoffAt, actorId, expected.at);
      rearmedAt = cutoffAt.toISOString();
    }
  }
  return {
    ...(await getExpectedArrival(prisma, entryId)),
    rearmedAt,
    cutoffAlreadyReached: reached,
  };
}
