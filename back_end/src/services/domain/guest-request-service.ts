import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import * as auditService from "../infrastructure/audit-service.js";

/**
 * Guest requests — what the guest asked the hotel to arrange (BE-64, built 2026-10-12, operator:
 * "guest request, which shows all the guest's requests, shown and added", on every step).
 *
 * A request is a kind from the `guestRequest.kinds` setting, what exactly, and — when it has
 * one — the day and time it is for. It is ASKED until the desk marks it ARRANGED; one taken back
 * is WITHDRAWN with a reason, never deleted. The guest's standing preference (a high floor, a
 * quiet room) is not a request: it is the enquiry's preference line, served beside the list.
 *
 * Not built here (BE-64's remainder): kind-specific questions, the department's handoff raised
 * from a request, and saving a request to the guest's profile.
 */

type Actor = { actorId: string; level: ActorLevel };

/** The house's default list, used until the setting is written. */
export const DEFAULT_GUEST_REQUEST_KINDS = [
  "Airport pickup",
  "Airport drop",
  "Early check-in",
  "Late check-out",
  "Celebration (cake, flowers)",
  "Room set-up",
  "Food and drink",
  "Something else",
];

export async function resolveGuestRequestKinds(prisma: PrismaClient): Promise<string[]> {
  const row = await getActiveConfigEntry(prisma, "guestRequest.kinds");
  const v = row?.configValue;
  if (Array.isArray(v)) {
    const kinds = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    if (kinds.length) return kinds;
  }
  return DEFAULT_GUEST_REQUEST_KINDS;
}

async function entryOf(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      inquiry: { select: { notes: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

export async function listGuestRequests(prisma: PrismaClient, entryId: string) {
  const entry = await entryOf(prisma, entryId);
  const [rows, kinds] = await Promise.all([
    prisma.guestRequest.findMany({ where: { entryId }, orderBy: [{ createdAt: "desc" }] }),
    resolveGuestRequestKinds(prisma),
  ]);
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.arrangedBy, r.withdrawnBy]).filter((x): x is string => !!x))];
  const staff = ids.length ? await prisma.staffUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
  const names = new Map(staff.map((s) => [s.id, s.fullName]));
  const name = (id: string | null) => (id ? names.get(id) ?? id : null);
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    what: r.what,
    forDate: r.forDate ? ymdUtc(r.forDate) : null,
    forTime: r.forTime,
    state: r.state,
    stageContext: r.stageContext,
    createdAt: r.createdAt.toISOString(),
    createdByName: name(r.createdBy),
    arrangedAt: r.arrangedAt?.toISOString() ?? null,
    arrangedByName: name(r.arrangedBy),
    arrangedNote: r.arrangedNote,
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    withdrawnByName: name(r.withdrawnBy),
    withdrawnReason: r.withdrawnReason,
  }));
  return {
    items,
    kinds,
    preference: entry.inquiry?.notes?.trim() || null,
    stay: {
      checkInDate: entry.checkInDate ? ymdUtc(entry.checkInDate) : null,
      checkOutDate: (entry.actualCheckOutDate ?? entry.checkOutDate) ? ymdUtc((entry.actualCheckOutDate ?? entry.checkOutDate)!) : null,
    },
    counts: { open: items.filter((i) => i.state === "ASKED").length, total: items.length },
  };
}

export type AddGuestRequestInput = { kind: string; what: string; forDate?: string | null; forTime?: string | null };

export async function addGuestRequest(prisma: PrismaClient, actor: Actor, entryId: string, input: AddGuestRequestInput) {
  const entry = await entryOf(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const kinds = await resolveGuestRequestKinds(prisma);
  const kind = input.kind.trim();
  if (!kinds.includes(kind)) throw new ValidationError(`"${kind}" is not one of the request kinds — pick one from the list`);
  const what = input.what.trim();
  if (!what) throw new ValidationError("Say what the guest asked for");
  const forTime = input.forTime?.trim() || null;
  if (forTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(forTime)) throw new ValidationError("The time reads as HH:MM, e.g. 14:30");
  let forDate: Date | null = null;
  if (input.forDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.forDate)) throw new ValidationError("The day could not be read");
    forDate = new Date(`${input.forDate}T00:00:00.000Z`);
    if (forDate < hotelTodayUtc()) throw new ValidationError("That day has passed at the hotel");
    // The check-out morning is allowed — a late check-out or a drop to the airport falls on it.
    const out = entry.actualCheckOutDate ?? entry.checkOutDate;
    if (out && forDate > out) throw new ValidationError(`That day is after the guest leaves (${ymdUtc(out)})`);
  }
  if (forTime && !forDate) throw new ValidationError("A time needs its day");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const req = await tx.guestRequest.create({
      data: { entryId, kind, what, forDate, forTime, stageContext: entry.currentStage, createdBy: actor.actorId, createdAt: now },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "GUEST_REQUEST.ADDED",
      entityType: "Entry",
      entityId: entryId,
      operation: "CREATE",
      timestamp: now,
      inquiryId: entry.inquiryId,
      entryId,
      stageContext: entry.currentStage,
      payload: { requestId: req.id, kind, what, forDate: input.forDate ?? null, forTime },
    });
    return req;
  });
}

async function requestOf(prisma: PrismaClient, requestId: string) {
  const req = await prisma.guestRequest.findUnique({
    where: { id: requestId },
    include: { entry: { select: { status: true, inquiryId: true, currentStage: true } } },
  });
  if (!req) throw new NotFoundError("Request");
  return req;
}

/** The desk has arranged it. */
export async function arrangeGuestRequest(prisma: PrismaClient, actor: Actor, requestId: string, note?: string | null) {
  const req = await requestOf(prisma, requestId);
  enforceEntryNotSealedForWorkingAction({ status: req.entry.status });
  if (req.state !== "ASKED") throw new ValidationError(req.state === "ARRANGED" ? "This request is already arranged" : "This request was taken back");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.guestRequest.update({
      where: { id: requestId },
      data: { state: "ARRANGED", arrangedAt: now, arrangedBy: actor.actorId, arrangedNote: note?.trim() || null },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "GUEST_REQUEST.ARRANGED",
      entityType: "Entry",
      entityId: req.entryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: req.entry.inquiryId,
      entryId: req.entryId,
      stageContext: req.entry.currentStage,
      payload: { requestId, kind: req.kind, what: req.what, note: note?.trim() || null },
    });
    return updated;
  });
}

/** The guest no longer wants it — kept, with the reason. */
export async function withdrawGuestRequest(prisma: PrismaClient, actor: Actor, requestId: string, reasonIn: string) {
  const req = await requestOf(prisma, requestId);
  enforceEntryNotSealedForWorkingAction({ status: req.entry.status });
  if (req.state === "WITHDRAWN") throw new ValidationError("This request was already taken back");
  const reason = reasonIn.trim();
  if (!reason) throw new ValidationError("Say why it is taken back");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.guestRequest.update({
      where: { id: requestId },
      data: { state: "WITHDRAWN", withdrawnAt: now, withdrawnBy: actor.actorId, withdrawnReason: reason },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "GUEST_REQUEST.WITHDRAWN",
      entityType: "Entry",
      entityId: req.entryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: req.entry.inquiryId,
      entryId: req.entryId,
      stageContext: req.entry.currentStage,
      payload: { requestId, kind: req.kind, what: req.what, reason },
    });
    return updated;
  });
}
