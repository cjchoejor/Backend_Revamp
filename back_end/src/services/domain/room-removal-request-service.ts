import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { mayApprove, readApprovalRoles, enforceMayApprove } from "../../lib/approval-roles.js";
import { hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";
import { computeEarlyDepartureFigures } from "./early-departure-service.js";
import { recordRoomsLeavingEarly } from "./rooms-leaving-early-service.js";

/**
 * Removing a room booked by the hotel's mistake (2026-11-26, operator: "removing room is usually when
 * the hotel makes the mistake … if frontdesk does it, it should ask for approval from fom gm or admin").
 *
 * Whoever the admin console lets (`approvals.roomRemove.roles`, the FOM, the GM and admins as built)
 * removes the room straight away; anyone else ASKS here, and the bell rings for those who may. Approving
 * runs the same removal as the approver — every check again, on the booking as it stands then — and
 * names the records it made. One ask at a time per booking. Nothing moves until it is approved.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function present(r: {
  id: string;
  roomIds: string[];
  roomNumbers: string[];
  departureDate: Date;
  reason: string;
  status: string;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedLevel: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  recordIds: string[];
}) {
  return {
    id: r.id,
    roomIds: r.roomIds,
    roomNumbers: r.roomNumbers,
    departureDate: ymdUtc(r.departureDate),
    reason: r.reason,
    status: r.status as "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN",
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt.toISOString(),
    decidedBy: r.decidedBy,
    decidedLevel: r.decidedLevel,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    recordIds: r.recordIds,
  };
}

async function names(prisma: PrismaClient, ids: string[]) {
  const staff = await prisma.staffUser.findMany({ where: { id: { in: ids.filter(Boolean) } }, select: { id: true, fullName: true } }).catch(() => []);
  return new Map(staff.map((s) => [s.id, s.fullName]));
}

/** The asks on this booking, the latest first, and who may decide them. */
export async function readRoomRemovals(prisma: PrismaClient, entryId: string, actorLevel: string) {
  const rows = await prisma.roomRemovalRequest.findMany({ where: { entryId }, orderBy: { requestedAt: "desc" }, take: 10 });
  const who = await names(prisma, rows.flatMap((r) => [r.requestedBy, r.decidedBy ?? ""]));
  const roles = await readApprovalRoles(prisma, "ROOM_REMOVE");
  return {
    items: rows.map((r) => ({ ...present(r), requestedByName: who.get(r.requestedBy) ?? null, decidedByName: r.decidedBy ? who.get(r.decidedBy) ?? null : null })),
    waiting: rows.find((r) => r.status === "REQUESTED") ? present(rows.find((r) => r.status === "REQUESTED")!) : null,
    mayDecide: roles.levels.includes(actorLevel as never),
    approvers: roles.words,
  };
}

/** The desk asks for a room to come off the stay. Checked as the removal itself would be, nothing moved. */
export async function askToRemoveRoom(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { roomIds: string[]; departureDate?: string | null; reason: string },
) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say what went wrong — why the room comes off the stay");
  const roomIds = Array.from(new Set((input.roomIds ?? []).map((x) => x.trim()).filter(Boolean)));
  if (!roomIds.length) throw new ValidationError("Pick the room to remove");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, status: true, currentStage: true, inquiryId: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status !== "ACTIVE" || entry.currentStage !== Stage.S7) throw new ValidationError("A room is removed from a stay while the guests are in house");
  const open = await prisma.roomRemovalRequest.findFirst({ where: { entryId, status: "REQUESTED" } });
  if (open) throw new ValidationError(`Removing Room ${open.roomNumbers.join(", ")} is already waiting for an answer — take it back first to ask again`);

  const figures = await computeEarlyDepartureFigures(prisma, entryId, { departureDate: input.departureDate ?? null, roomIds });
  if (figures.scope !== "ROOMS") throw new ValidationError("Every room the stay uses would come off — keep at least one room");
  const hard = figures.blockers.find((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  if (hard) throw new PolicyGateBlockedError(hard.code, hard.message);
  const roomNumbers = figures.rooms.filter((r) => r.shortened).map((r) => r.roomNumber ?? r.roomId.slice(0, 6));
  const uniqueNumbers = Array.from(new Set(roomNumbers));
  const roles = await readApprovalRoles(prisma, "ROOM_REMOVE");
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const made = await tx.roomRemovalRequest.create({
      data: {
        entryId,
        roomIds,
        roomNumbers: uniqueNumbers,
        departureDate: new Date(`${figures.departureDate}T00:00:00.000Z`),
        reason,
        requestedBy: actor.actorId,
        requestedLevel: actor.actorLevel,
        requestedAt: now,
      },
    });
    const payload = { requestId: made.id, roomNumbers: uniqueNumbers, departureDate: figures.departureDate, reason, approvers: roles.words };
    await tx.traceEvent.create({
      data: {
        eventType: "ROOM_REMOVAL.REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload,
        createdBy: actor.actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "NOTIFICATION.ROOM_REMOVAL_REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { ...payload, entryId, targets: roles.levels.includes("L2") ? ["FOM", "GM"] : ["GM"], severity: "WARNING" },
        createdBy: actor.actorId,
      },
    });
    return made;
  });
  return { request: present(row), approvers: roles.words };
}

/** Approve (the room comes off, as the approver) or turn down (in words). */
export async function decideRoomRemoval(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  requestId: string,
  input: { decision: "APPROVE" | "REJECT"; note?: string | null },
) {
  await enforceMayApprove(prisma, "ROOM_REMOVE", actor.actorLevel);
  const row = await prisma.roomRemovalRequest.findUnique({ where: { id: requestId } });
  if (!row || row.entryId !== entryId) throw new NotFoundError("RoomRemovalRequest");
  if (row.status !== "REQUESTED") throw new ValidationError(`This ask was already ${row.status.toLowerCase()}`);
  const note = input.note?.trim() || null;
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  const now = new Date();
  if (input.decision === "REJECT") {
    if (!note) throw new ValidationError("Say why — the desk reads it");
    const done = await prisma.roomRemovalRequest.updateMany({
      where: { id: requestId, status: "REQUESTED" },
      data: { status: "REJECTED", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now, decisionNote: note },
    });
    if (done.count !== 1) throw new ValidationError("This ask was answered on another screen");
    await prisma.traceEvent.create({
      data: {
        eventType: "ROOM_REMOVAL.REJECTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry?.inquiryId ?? null,
        entryId,
        payload: { requestId, roomNumbers: row.roomNumbers, note },
        createdBy: actor.actorId,
      },
    });
    return { decision: "REJECT" as const, removal: null, entry: await loadEntryDetail(prisma, entryId) };
  }
  // Approving IS removing, as the approver, on the booking as it stands now.
  const day = ymdUtc(row.departureDate);
  const today = ymdUtc(hotelTodayUtc());
  const outcome = await recordRoomsLeavingEarly(prisma, actor, entryId, {
    departureDate: day < today ? today : day,
    roomIds: row.roomIds,
    billing: "TOGETHER",
    reason: row.reason,
    kind: "REMOVED",
  });
  await prisma.roomRemovalRequest.update({
    where: { id: requestId },
    data: { status: "APPROVED", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now, decisionNote: note, recordIds: outcome.records.map((r) => r.id) },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "ROOM_REMOVAL.APPROVED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: entry?.inquiryId ?? null,
      entryId,
      payload: { requestId, roomNumbers: row.roomNumbers, note, recordIds: outcome.records.map((r) => r.id), from: fmtDay(outcome.departureDate) },
      createdBy: actor.actorId,
    },
  });
  return { decision: "APPROVE" as const, removal: { ...outcome, entry: undefined }, entry: outcome.entry };
}

/** The desk takes its ask back before anyone answered. */
export async function withdrawRoomRemoval(prisma: PrismaClient, actor: Actor, entryId: string, requestId: string) {
  const row = await prisma.roomRemovalRequest.findUnique({ where: { id: requestId } });
  if (!row || row.entryId !== entryId) throw new NotFoundError("RoomRemovalRequest");
  if (row.status !== "REQUESTED") throw new ValidationError(`This ask was already ${row.status.toLowerCase()}`);
  const now = new Date();
  const done = await prisma.roomRemovalRequest.updateMany({
    where: { id: requestId, status: "REQUESTED" },
    data: { status: "WITHDRAWN", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now },
  });
  if (done.count !== 1) throw new ValidationError("This ask was answered on another screen");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  await prisma.traceEvent.create({
    data: {
      eventType: "ROOM_REMOVAL.WITHDRAWN",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: entry?.inquiryId ?? null,
      entryId,
      payload: { requestId, roomNumbers: row.roomNumbers },
      createdBy: actor.actorId,
    },
  });
  return { withdrawn: true };
}

/** For an approver's own direct removal: may they, and the words when not. */
export async function mayRemoveRooms(prisma: PrismaClient, level: string) {
  return mayApprove(prisma, "ROOM_REMOVE", level);
}
