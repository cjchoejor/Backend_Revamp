import type { PrismaClient } from "@prisma/client";
import { FolioLineType, InventoryClaimState, Prisma, Stage } from "@prisma/client";
import { AppError, AuthorizationError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { requireActiveMode } from "../../lib/mode-registry-runtime.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";
import { hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
import { enforceEarlyDepartureAuthority, enforceSleptNightsAuditedForEarlyDeparture } from "../../policies/14-cancellation/p36-early-departure.js";
import { computeEarlyDepartureFigures, recordEarlyDeparture, type EarlyDepartureFigures } from "./early-departure-service.js";
import { postCharge } from "./s7-folio-lines-service.js";
import { releaseRoomFromStayTx, scheduleCleaningAfterLeaving } from "./room-early-departure-service.js";
import { returnRoomKey } from "./room-key-service.js";

/**
 * Leaving early — the whole booking, or some of its rooms (2026-11-26, operator: "in the change
 * booking in the stay stage, in leaving early section, where it will show leaving early as all the
 * rooms or just particular rooms, when leaving like today or some date before the actual booking's
 * check out date, and then option to bill it together with the other stays or pay their own for the
 * room bills, cancellation policy should be applied and also waive option for higher authority").
 *
 * The whole booking leaving goes through `recordEarlyDeparture`, unchanged but for a later day: the
 * stay is shortened now and checks out on that day as usual.
 *
 * Some rooms leaving, the rest staying:
 *  - each room's row ends on the departure day with its frozen figures scaled to the nights slept —
 *    the rule every early departure uses, so the night audit stops charging the room and the bill's
 *    rate check still holds; the nights given up are free for other guests at once;
 *  - the hotel's early-departure fee (`earlyDeparture.penalty`, the same rule as the whole booking's,
 *    one fee per room) is posted ON THE ROOM, on whoever pays the room — or waived by the GM;
 *  - TOGETHER: the room's charges stay on the booking's bill, paid at check-out. OWN: the room pays
 *    its own share as it leaves (the desk takes it against the room);
 *  - leaving today, the room is released now (departed, to be cleaned); leaving on a later day, it is
 *    SCHEDULED and the desk releases it that day.
 * Recording is the GM's (Policy 36): nights are given up. Releasing a scheduled room on its day is the
 * desk's — the decision was the GM's.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
type Billing = "TOGETHER" | "OWN";

export type RoomsLeavingOutcome = {
  scope: "ROOMS";
  departureDate: string;
  later: boolean;
  billing: Billing;
  records: Array<{
    id: string;
    roomId: string;
    roomNumber: string;
    unstayedNights: number;
    forgoneTotal: number;
    feeAmount: number;
    feeWaived: boolean;
    feeLineId: string | null;
    feeError: string | null;
    state: "SCHEDULED" | "LEFT";
  }>;
  figures: EarlyDepartureFigures;
  entry: Awaited<ReturnType<typeof loadEntryDetail>>;
};

const fmtDay = (ymd: string) =>
  new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;

/** The whole booking or some rooms — whichever the rooms named come to. */
export async function recordLeavingEarly(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { departureDate?: string | null; roomIds?: string[] | null; billing?: Billing | null; reason: string; waiveFee?: boolean; waiveReason?: string | null },
) {
  const peek = await computeEarlyDepartureFigures(prisma, entryId, { departureDate: input.departureDate ?? null, roomIds: input.roomIds ?? null });
  if (peek.scope === "BOOKING") {
    return { scope: "BOOKING" as const, ...(await recordEarlyDeparture(prisma, actor, entryId, input)) };
  }
  return recordRoomsLeavingEarly(prisma, actor, entryId, { ...input, roomIds: peek.roomIds, billing: input.billing ?? "TOGETHER" });
}

export async function recordRoomsLeavingEarly(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { departureDate?: string | null; roomIds: string[]; billing: Billing; reason: string; waiveFee?: boolean; waiveReason?: string | null },
): Promise<RoomsLeavingOutcome> {
  enforceEarlyDepartureAuthority({ actorLevel: actor.actorLevel });
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the rooms leave early");
  const waived = input.waiveFee === true;
  if (waived && !input.waiveReason?.trim()) throw new ValidationError("Waiving the fee needs a reason");
  if (input.billing !== "TOGETHER" && input.billing !== "OWN") throw new ValidationError("Say whether the rooms' charges stay on the booking's bill or they pay their own");
  await requireActiveMode(prisma, "EARLY_DEPARTURE");

  const figures = await computeEarlyDepartureFigures(prisma, entryId, { departureDate: input.departureDate ?? null, roomIds: input.roomIds });
  if (figures.scope !== "ROOMS") throw new ValidationError("Every room the stay uses would leave — that is the whole booking leaving early");
  const hard = figures.blockers.find((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  if (hard) {
    if (hard.code === "DEPARTURE_DATE") throw new ValidationError(hard.message);
    throw new PolicyGateBlockedError(hard.code, hard.message);
  }
  enforceSleptNightsAuditedForEarlyDeparture({ missingNightYmds: figures.missingNightYmds });

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, inquiryId: true, folio: { select: { id: true } } } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");
  const folioId = entry.folio.id;
  const departure = new Date(`${figures.departureDate}T00:00:00.000Z`);
  const now = new Date();
  const later = figures.later;

  // One record per room, from its shortened row(s).
  const byRoom = new Map<string, typeof figures.rooms>();
  for (const r of figures.rooms) {
    if (!r.shortened) continue;
    byRoom.set(r.roomId, [...(byRoom.get(r.roomId) ?? []), r]);
  }
  const ruleBasis = { rule: figures.fee.rule, serviceChargeRate: figures.fee.serviceChargeRate, gstRate: figures.fee.gstRate, explanation: figures.fee.explanation };

  const made = await prisma.$transaction(async (tx) => {
    const out: Array<{ id: string; roomId: string; roomNumber: string; unstayed: number; forgoneTotal: number; fee: number; description: string }> = [];
    for (const [roomId, rows] of byRoom) {
      const roomNumber = rows[0].roomNumber ?? roomId.slice(0, 6);
      let forgoneSub = new Prisma.Decimal(0);
      let forgoneTot = new Prisma.Decimal(0);
      let fee = new Prisma.Decimal(0);
      let unstayed = 0;
      let slept = 0;
      let before: { sub: Prisma.Decimal | null; tot: Prisma.Decimal | null } = { sub: null, tot: null };
      for (const r of rows) {
        const live = await tx.roomAssignment.findUniqueOrThrow({ where: { id: r.assignmentId }, select: { frozenSubtotal: true, frozenTotal: true } });
        before = { sub: live.frozenSubtotal ?? null, tot: live.frozenTotal ?? null };
        const rowStart = new Date(`${r.startDate}T00:00:00.000Z`);
        await tx.roomAssignment.update({
          where: { id: r.assignmentId },
          data: {
            startDate: rowStart,
            endDate: departure.getTime() > rowStart.getTime() ? departure : rowStart,
            ...(r.newFrozenSubtotal != null ? { frozenSubtotal: new Prisma.Decimal(r.newFrozenSubtotal) } : {}),
            ...(r.newFrozenTotal != null ? { frozenTotal: new Prisma.Decimal(r.newFrozenTotal) } : {}),
          },
        });
        forgoneSub = forgoneSub.plus(r.forgoneSubtotal);
        forgoneTot = forgoneTot.plus(r.forgoneTotal);
        fee = fee.plus(r.feeAmount ?? 0);
        unstayed = Math.max(unstayed, r.unstayedNights);
        slept = Math.max(slept, r.sleptNights);
      }
      const last = rows.map((r) => r.endDate).sort().at(-1)!;
      const feeAmount = waived ? new Prisma.Decimal(0) : fee;
      const id = await allocateReadableId(tx, "EARLY_DEPARTURE" as const, now);
      await tx.roomDepartureRecord.create({
        data: {
          id,
          entryId,
          roomId,
          roomNumber,
          assignmentId: rows[0].assignmentId,
          departureDate: departure,
          originalEndDate: new Date(`${last}T00:00:00.000Z`),
          sleptNights: slept,
          unstayedNights: unstayed,
          forgoneSubtotal: forgoneSub,
          forgoneTotal: forgoneTot,
          frozenSubtotalBefore: before.sub,
          frozenTotalBefore: before.tot,
          feeBasis: { ...ruleBasis, computedAmount: fee.toFixed(2), waived, waiveReason: waived ? input.waiveReason!.trim() : null } as Prisma.InputJsonValue,
          feeAmount,
          feeWaived: waived,
          billing: input.billing,
          state: later ? "SCHEDULED" : "LEFT",
          leftAt: later ? null : now,
          leftBy: later ? null : actor.actorId,
          reason,
          recordedAt: now,
          recordedBy: actor.actorId,
          recordedByLevel: actor.actorLevel,
        },
      });
      if (!later) {
        await releaseRoomFromStayTx(tx, {
          roomId,
          roomNumber,
          entryId,
          inquiryId: entry.inquiryId,
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          reason: `Left early — ${reason}`,
          payload: { recordId: id, departureDate: figures.departureDate, sleptNights: slept, unstayedNights: unstayed, forgoneTotal: forgoneTot.toFixed(2), billing: input.billing },
        });
      }
      const booked = fmtDay(last);
      out.push({
        id,
        roomId,
        roomNumber,
        unstayed,
        forgoneTotal: Number(forgoneTot.toFixed(2)),
        fee: Number(feeAmount.toFixed(2)),
        description: `Early departure fee · Room ${roomNumber} · leaving ${nightsWord(unstayed)} early (from ${fmtDay(figures.departureDate)}; booked to ${booked})`,
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.ROOMS_LEAVING_EARLY",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          departureDate: figures.departureDate,
          later,
          billing: input.billing,
          rooms: out.map((o) => ({ recordId: o.id, roomId: o.roomId, roomNumber: o.roomNumber, unstayedNights: o.unstayed, forgoneTotal: o.forgoneTotal, feeAmount: o.fee })),
          feeWaived: waived,
          waiveReason: waived ? input.waiveReason!.trim() : null,
          feeBasis: figures.fee.rule.basis,
          reason,
          mode: "EARLY_DEPARTURE",
        },
        createdBy: actor.actorId,
      },
    });
    return out;
  });

  // The fee, on each room, on whoever pays the room (the stay as booked) — never dated ahead.
  const records: RoomsLeavingOutcome["records"] = [];
  const stayPayer = await resolveBillingModelForNewLine(prisma as never, folioId, FolioLineType.ROOM_CHARGE);
  for (const m of made) {
    let feeLineId: string | null = null;
    let feeError: string | null = null;
    if (m.fee > 0) {
      try {
        const line = await postCharge(prisma, folioId, actor.actorId, {
          entryId,
          lineType: FolioLineType.SERVICE,
          description: m.description,
          amount: m.fee,
          currency: "BTN",
          chargeDate: `${figures.hotelToday}T00:00:00.000Z`,
          roomId: m.roomId,
          allowSoftGateBypass: true,
          billingModelOverride: stayPayer,
        });
        feeLineId = (line as { id?: string } | null)?.id ?? null;
        await prisma.roomDepartureRecord.update({ where: { id: m.id }, data: { feeFolioLineId: feeLineId } });
      } catch (e) {
        feeError = e instanceof Error ? e.message : String(e);
      }
    }
    records.push({
      id: m.id,
      roomId: m.roomId,
      roomNumber: m.roomNumber,
      unstayedNights: m.unstayed,
      forgoneTotal: m.forgoneTotal,
      feeAmount: m.fee,
      feeWaived: waived,
      feeLineId,
      feeError,
      state: later ? "SCHEDULED" : "LEFT",
    });
  }

  if (!later) {
    for (const m of made) await scheduleCleaningAfterLeaving(prisma, { entryId, roomId: m.roomId, actorId: actor.actorId });
    const { reconcileTonightBestEffort } = await import("../application/s7-night-audit-service.js");
    await reconcileTonightBestEffort(prisma, {
      entryId,
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      reason: `Room${made.length > 1 ? "s" : ""} ${made.map((m) => m.roomNumber).join(", ")} left early — tonight is not charged for ${made.length > 1 ? "them" : "it"}`,
    });
  }

  return { scope: "ROOMS", departureDate: figures.departureDate, later, billing: input.billing, records, figures, entry: await loadEntryDetail(prisma, entryId) };
}

/** Every room recorded to leave early on this booking, the latest first. */
export async function listRoomDepartures(prisma: PrismaClient, entryId: string) {
  const rows = await prisma.roomDepartureRecord.findMany({ where: { entryId }, orderBy: { recordedAt: "desc" } });
  const today = ymdUtc(hotelTodayUtc());
  return rows.map((r) => ({
    id: r.id,
    roomId: r.roomId,
    roomNumber: r.roomNumber,
    departureDate: ymdUtc(r.departureDate),
    originalEndDate: ymdUtc(r.originalEndDate),
    sleptNights: r.sleptNights,
    unstayedNights: r.unstayedNights,
    forgoneTotal: Number(r.forgoneTotal),
    feeAmount: Number(r.feeAmount),
    feeWaived: r.feeWaived,
    waiveReason: ((r.feeBasis ?? {}) as { waiveReason?: string | null }).waiveReason ?? null,
    feeLineId: r.feeFolioLineId,
    billing: r.billing as Billing,
    state: r.state as "SCHEDULED" | "LEFT",
    /** A scheduled room whose day has come — the desk releases it now. */
    dueToday: r.state === "SCHEDULED" && ymdUtc(r.departureDate) <= today,
    leftAt: r.leftAt?.toISOString() ?? null,
    reason: r.reason,
    recordedAt: r.recordedAt.toISOString(),
  }));
}

/**
 * A room recorded to leave on a later day leaves now: released, to be cleaned, and — when asked —
 * its key back. The desk's act (the GM decided the nights); refused before its day, so a room is
 * never emptied ahead of the nights it is still charged for.
 */
export async function releaseScheduledRoomDeparture(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  recordId: string,
  input: { keyReturned?: boolean },
) {
  const rec = await prisma.roomDepartureRecord.findUnique({ where: { id: recordId } });
  if (!rec || rec.entryId !== entryId) throw new NotFoundError("Room departure");
  if (rec.state !== "SCHEDULED") throw new ValidationError(`Room ${rec.roomNumber} has already left`);
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { status: true, currentStage: true, inquiryId: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status !== "ACTIVE" || entry.currentStage !== Stage.S7) throw new ValidationError("A room is released from a stay still in house");
  const today = ymdUtc(hotelTodayUtc());
  const day = ymdUtc(rec.departureDate);
  if (day > today) throw new ValidationError(`Room ${rec.roomNumber} leaves on ${fmtDay(day)} — release it that day; its nights until then are still charged`);
  const room = await prisma.room.findUnique({ where: { id: rec.roomId }, select: { currentClaimState: true } });
  const occupied = room?.currentClaimState === InventoryClaimState.OCCUPIED;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const done = await tx.roomDepartureRecord.updateMany({ where: { id: recordId, state: "SCHEDULED" }, data: { state: "LEFT", leftAt: now, leftBy: actor.actorId } });
    if (done.count !== 1) throw new ValidationError(`Room ${rec.roomNumber} has already left`);
    if (occupied) {
      await releaseRoomFromStayTx(tx, {
        roomId: rec.roomId,
        roomNumber: rec.roomNumber,
        entryId,
        inquiryId: entry.inquiryId,
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        reason: `Left early as recorded (${rec.id}) — ${rec.reason}`,
        payload: { recordId: rec.id, departureDate: day, billing: rec.billing, scheduled: true },
      });
    }
  });
  if (occupied) await scheduleCleaningAfterLeaving(prisma, { entryId, roomId: rec.roomId, actorId: actor.actorId });
  let keyError: string | null = null;
  if (input.keyReturned) {
    try {
      await returnRoomKey(prisma, entryId, rec.roomId, actor.actorId);
    } catch (e) {
      keyError = e instanceof AppError || e instanceof AuthorizationError ? e.message : e instanceof Error ? e.message : String(e);
    }
  }
  const { reconcileTonightBestEffort } = await import("../application/s7-night-audit-service.js");
  await reconcileTonightBestEffort(prisma, { entryId, actorId: actor.actorId, actorLevel: actor.actorLevel, reason: `Room ${rec.roomNumber} left — tonight is not charged for it` });
  return { released: occupied, keyError, departures: await listRoomDepartures(prisma, entryId), entry: await loadEntryDetail(prisma, entryId) };
}
