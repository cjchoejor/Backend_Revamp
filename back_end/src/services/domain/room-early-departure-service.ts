import { InventoryClaimState, Prisma, Stage } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { round2, toDecimal } from "../../lib/money.js";
import { hotelTodayUtc, nightsBetweenUtc, ymdUtc } from "../../lib/stay-dates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";

/**
 * ONE room of a multi-room booking leaves while the rest of the party stays (2026-09-09,
 * PMS-237, operator ruling: "say one of the guests stays for 2 nights and decides to pay for 2
 * nights and leave but the other guest still stays — the system only detects entry-wise
 * check-out … flag the room as guest is still staying or left").
 *
 * [docs/early-departure.md](../../../docs/early-departure.md) lists "one-room-leaves-early" as
 * deliberately NOT built; this is that, and it is deliberately NARROWER than the whole-booking
 * feature it sits beside:
 *
 *   - The BOOKING does not end. The entry stays at S7, the folio stays open, the other rooms
 *     keep being audited. Nothing is compressed to S8 and no S8 gate is consulted.
 *   - No early-departure FEE is posted. The fee in `earlyDeparture.penalty` is priced against a
 *     stay ending early, not a room emptying early, and inventing a per-room reading of it
 *     would be making up policy.
 *   - No `EarlyDepartureRecord` is written — that record means "this booking ended early", and
 *     writing one here would make every downstream reader (`effectiveCheckOutDate`, the billing
 *     summary's shortened-stay block, the claim end) believe the whole stay was cut short.
 *
 * What it DOES do is the part that must not be got wrong: the room's assignment row is
 * end-dated at the departure with its frozen figures **scaled to the nights actually slept** —
 * exactly the rule the whole-booking early departure and the mid-stay room change already use —
 * so the night audit stops posting nights nobody sleeps, and the slept nights stay billed
 * precisely as they were audited. Nothing is re-quoted; the rate is never retrospectively
 * renegotiated.
 */
export type RoomDepartureOutcome = {
  roomId: string;
  roomNumber: string | null;
  assignmentId: string;
  departureDate: string;
  sleptNights: number;
  unstayedNights: number;
  /** NET room revenue the hotel forgoes by releasing the room now. 0 when nothing was cut. */
  forgoneSubtotal: number;
  forgoneTotal: number;
  roomReleased: boolean;
  /** True when the row already ended today or earlier — a plain release, nothing forgone. */
  nothingForgone: boolean;
};

const ALREADY_DEPARTED = new Set<string>([InventoryClaimState.DEPARTED_DIRTY, InventoryClaimState.DEPARTED_CLEAN]);

/**
 * Authority follows what MOVED, not the act's name — the same doctrine p58 applies to room
 * changes. Releasing a room whose nights are all slept forgoes nothing and is plain desk work
 * (L1). Releasing one with nights still to run forgoes that revenue, which is precisely the
 * decision `POST /entries/:id/early-departure` reserves for the GM — so it carries the SAME
 * level here. Routing it through a payment must not be a cheaper door into the same act.
 */
export function requiredLevelForRoomDeparture(unstayedNights: number): "L1" | "L3" {
  return unstayedNights > 0 ? "L3" : "L1";
}

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export async function departRoomEarly(
  prisma: PrismaClient,
  input: {
    entryId: string;
    roomId: string;
    actorId: string;
    actorLevel: "L1" | "L2" | "L3" | "L4";
    reason?: string;
  },
): Promise<RoomDepartureOutcome> {
  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    include: {
      reservation: true,
      roomAssignments: { include: { room: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status !== "ACTIVE") {
    throw new ValidationError(`This booking is ${entry.status} — a room can only be released from a live stay`);
  }
  // In-house only. At S8 the WHOLE booking is checking out and the normal settlement path
  // releases every room; before S7 nobody is in the room to leave it.
  if (entry.currentStage !== Stage.S7) {
    throw new ValidationError(
      `A room is released mid-stay (S7) — this booking is at ${entry.currentStage}. At check-out the whole booking's settlement releases its rooms.`,
    );
  }

  const distinctRoomIds = new Set(entry.roomAssignments.map((a) => a.roomId));
  if (distinctRoomIds.size <= 1) {
    throw new ValidationError(
      "This booking has one room, so releasing it ends the stay — use the early-departure route, which prices the forgone nights, posts the fee and moves the booking to Check-out.",
    );
  }

  const rows = entry.roomAssignments.filter((a) => a.roomId === input.roomId);
  if (rows.length === 0) throw new ValidationError("roomId is not a room of this booking");
  const room = rows[0].room;
  if (ALREADY_DEPARTED.has(String(room.currentClaimState))) {
    throw new ValidationError(`Room ${room.roomNumber} has already been released`);
  }
  if (room.currentClaimState !== InventoryClaimState.OCCUPIED) {
    throw new ValidationError(
      `Room ${room.roomNumber} is ${room.currentClaimState} — only an occupied room can be released as departed`,
    );
  }

  const departure = hotelTodayUtc();
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const bookedOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!checkIn || !bookedOut) throw new ValidationError("This booking has no stay dates to measure a departure against");

  // The row still running is the one to end. A room the guest already moved out of (a mid-stay
  // change) is end-dated already and is not what "release this room" means.
  const live = rows
    .filter((a) => (a.endDate ?? bookedOut).getTime() > departure.getTime() || a.endDate == null)
    .sort((a, b) => (a.startDate ?? checkIn).getTime() - (b.startDate ?? checkIn).getTime())
    .at(-1) ?? rows[rows.length - 1];

  const rowStart = live.startDate ?? checkIn;
  const rowEnd = live.endDate ?? bookedOut;
  const totalNights = nightsBetweenUtc(rowStart, rowEnd);
  const sleptEnd = departure.getTime() < rowEnd.getTime() ? departure : rowEnd;
  const sleptNights = Math.max(0, Math.min(totalNights, nightsBetweenUtc(rowStart, sleptEnd)));
  const unstayedNights = Math.max(0, totalNights - sleptNights);

  const needed = requiredLevelForRoomDeparture(unstayedNights);
  if ((LEVEL_RANK[input.actorLevel] ?? 1) < LEVEL_RANK[needed]) {
    throw new AuthorizationError(
      `Releasing Room ${room.roomNumber} now gives up ${unstayedNights} unstayed night${unstayedNights === 1 ? "" : "s"} — that needs the GM, the same as any early departure.`,
    );
  }

  // Frozen figures scale to the nights actually slept — the whole-booking early departure's
  // rule, unchanged. A legacy flat row (no frozenSubtotal) is left alone; there is nothing
  // stored on it to scale, and guessing would invent money.
  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);
  const taxFactor = new Prisma.Decimal(1).plus(serviceChargeRate).mul(new Prisma.Decimal(1).plus(gstRate));
  let newFrozenSubtotal: Prisma.Decimal | null = null;
  let newFrozenTotal: Prisma.Decimal | null = null;
  let forgoneSub = new Prisma.Decimal(0);
  let forgoneTot = new Prisma.Decimal(0);
  if (live.frozenSubtotal != null && totalNights > 0 && unstayedNights > 0) {
    const sub = toDecimal(live.frozenSubtotal);
    const tot = live.frozenTotal != null ? toDecimal(live.frozenTotal) : round2(sub.mul(taxFactor));
    const scale = new Prisma.Decimal(sleptNights).div(totalNights);
    newFrozenSubtotal = round2(sub.mul(scale));
    newFrozenTotal = round2(tot.mul(scale));
    forgoneSub = round2(sub.minus(newFrozenSubtotal));
    forgoneTot = round2(tot.minus(newFrozenTotal));
  }

  const windowMinutes = Number(await requireActiveConfigValue<number>(prisma as never, "housekeeping.sla.windowMinutes"));
  const dueAt = new Date(Date.now() + (Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60) * 60_000);

  await prisma.$transaction(async (tx) => {
    // End-date the row so the night audit posts nothing for nights nobody sleeps. Per-row
    // update only — the db.ts guard forbids `roomAssignment.updateMany`.
    if (unstayedNights > 0) {
      await tx.roomAssignment.update({
        where: { id: live.id },
        data: {
          endDate: departure,
          ...(newFrozenSubtotal != null ? { frozenSubtotal: newFrozenSubtotal } : {}),
          ...(newFrozenTotal != null ? { frozenTotal: newFrozenTotal } : {}),
        },
      });
    }

    await tx.room.update({ where: { id: room.id }, data: { currentClaimState: InventoryClaimState.DEPARTED_DIRTY } });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: room.id,
        entryId: entry.id,
        fromState: InventoryClaimState.OCCUPIED,
        toState: InventoryClaimState.DEPARTED_DIRTY,
        actorId: input.actorId,
        reason: input.reason?.trim() || "Guest of this room left; the rest of the booking stays",
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "ROOM.RELEASED_MID_STAY",
        actorId: input.actorId,
        actorLevel: input.actorLevel,
        entityType: "Room",
        entityId: room.id,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          roomId: room.id,
          roomNumber: room.roomNumber,
          assignmentId: live.id,
          departureDate: ymdUtc(departure),
          rowStart: ymdUtc(rowStart),
          rowEndBefore: ymdUtc(rowEnd),
          totalNights,
          sleptNights,
          unstayedNights,
          forgoneSubtotal: forgoneSub.toFixed(2),
          forgoneTotal: forgoneTot.toFixed(2),
          frozenSubtotalBefore: live.frozenSubtotal?.toString() ?? null,
          frozenSubtotalAfter: newFrozenSubtotal?.toString() ?? live.frozenSubtotal?.toString() ?? null,
          reason: input.reason?.trim() ?? null,
          requiredLevel: needed,
        },
        createdBy: input.actorId,
      },
    });
  });

  // Post-commit, best-effort: housekeeping has to know the room needs turning over. A failure
  // here leaves the room durably DEPARTED_DIRTY, which is the fact that matters.
  try {
    const engine = await getTimerEngine();
    const timerRecordId = randomUUID();
    const pgBossJobId = await engine.schedule("HOUSEKEEPING_SLA_W24", { entryId: entry.id, roomId: room.id, timerRecordId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId: entry.id,
        entityType: "Room",
        entityId: room.id,
        timerType: "HOUSEKEEPING_SLA_W24",
        timerCode: "HOUSEKEEPING_SLA_W24",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId,
        createdBy: input.actorId,
        payload: { roomId: room.id, entryId: entry.id, timerRecordId },
      },
    });
  } catch {
    // swallowed on purpose — see above
  }

  return {
    roomId: room.id,
    roomNumber: room.roomNumber,
    assignmentId: live.id,
    departureDate: ymdUtc(departure),
    sleptNights,
    unstayedNights,
    forgoneSubtotal: Number(forgoneSub.toFixed(2)),
    forgoneTotal: Number(forgoneTot.toFixed(2)),
    roomReleased: true,
    nothingForgone: unstayedNights === 0,
  };
}
