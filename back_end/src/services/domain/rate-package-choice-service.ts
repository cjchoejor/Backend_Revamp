/**
 * WHICH PACKAGE PRICES A ROOM TYPE (2026-11-13, operator: "bhutan inc agent is chosen, and packages
 * seasonal and non season is chosen … suite can be chosen seasonal and standard also seasonal and
 * premium can be chosen non season, and those base rates will be applied to those room types, also in
 * negotiation, their respective meal plan and other rates will be pulled and used").
 *
 * The enquiry holds the packages chosen for the booking (`Inquiry.ratePackageIds`, the primary first);
 * each stay says which of them prices each of its room types (`Entry.ratePackageByRoomType`). A type
 * given none is priced on the primary. Every price reader asks `resolveRatePackageForBooking`, which
 * reads both — the search, the S1 bill, the rate reference, the live table and the quotation.
 *
 * Chosen at Inquiry and Negotiation only: from Set up on the rates are the quotation's, and a change
 * goes through the governed walks, which price again on what is chosen here.
 */
import { Prisma, type ActorLevel, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import * as auditService from "../infrastructure/audit-service.js";

type Actor = { actorId: string; level: ActorLevel };

export async function setRoomTypePackage(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { roomTypeId: string; ratePackageId: string | null },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      ratePackageByRoomType: true,
      inquiry: { select: { ratePackageId: true, ratePackageIds: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (entry.currentStage !== "S1" && entry.currentStage !== "S2") {
    throw new ValidationError(
      "A room type's package is chosen at Inquiry and Negotiation — from Set up on the rates are the quotation's.",
    );
  }
  const type = await prisma.roomType.findUnique({ where: { id: input.roomTypeId }, select: { id: true, name: true } });
  if (!type) throw new NotFoundError("Room type");

  const chosen = entry.inquiry?.ratePackageIds?.length
    ? entry.inquiry.ratePackageIds
    : entry.inquiry?.ratePackageId
      ? [entry.inquiry.ratePackageId]
      : [];
  if (input.ratePackageId && !chosen.includes(input.ratePackageId)) {
    throw new ValidationError("That package is not one chosen for this booking — tick it in the caller's section first.");
  }

  const before = (entry.ratePackageByRoomType ?? {}) as Record<string, string>;
  const priorId = typeof before[type.id] === "string" && chosen.includes(before[type.id]) ? before[type.id] : null;
  const next: Record<string, string> = { ...before };
  if (input.ratePackageId) next[type.id] = input.ratePackageId;
  else delete next[type.id];
  if ((priorId ?? null) === (input.ratePackageId ?? null)) {
    return { entryId, roomTypeId: type.id, ratePackageId: input.ratePackageId, changed: false, ratePackageByRoomType: before };
  }

  const names = await prisma.ratePackage.findMany({
    where: { id: { in: [priorId, input.ratePackageId, chosen[0]].filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = (id: string | null) => (id ? names.find((n) => n.id === id)?.name ?? null : null);
  const primaryName = nameOf(chosen[0] ?? null);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.entry.update({
      where: { id: entryId },
      data: {
        ratePackageByRoomType: Object.keys(next).length ? (next as Prisma.InputJsonValue) : Prisma.DbNull,
        version: { increment: 1 },
      },
    });
    await auditService.emit(tx as never, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "ENTRY.RATE_PACKAGE_FOR_ROOM_TYPE_SET",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: entry.currentStage as never,
      inquiryId: entry.inquiryId,
      entryId,
      payload: {
        roomTypeId: type.id,
        roomTypeName: type.name,
        from: priorId ? { ratePackageId: priorId, name: nameOf(priorId) } : { primary: true, name: primaryName },
        to: input.ratePackageId ? { ratePackageId: input.ratePackageId, name: nameOf(input.ratePackageId) } : { primary: true, name: primaryName },
      },
    });
  });
  return { entryId, roomTypeId: type.id, ratePackageId: input.ratePackageId, changed: true, ratePackageByRoomType: next };
}
