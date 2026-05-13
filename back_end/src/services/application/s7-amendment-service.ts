import type { PrismaClient } from "@prisma/client";
import { InventoryClaimState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { computeReEntryConsequences } from "../../engines/re-entry-consequence-engine.js";
import { enforceEntryAtS7ForRoomChangeReEntry } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

export async function createAmendmentEvent(
  prisma: PrismaClient,
  actorId: string,
  input: {
    entryId: string;
    segmentId: string;
    amendmentPath: "PATH_1" | "PATH_2" | "PATH_3";
    amendmentType: string;
    requestedBy: string;
    authorisedBy: string;
    authorityBasis: string;
    reason: string;
    priorTermsRef?: string;
    newTermsSummary: string;
    folioLineId?: string;
    stageAtAmendment: Stage;
  },
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.segmentId?.trim()) throw new ValidationError("segmentId is required");
  if (!input.amendmentType?.trim()) throw new ValidationError("amendmentType is required");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  if (!input.newTermsSummary?.trim()) throw new ValidationError("newTermsSummary is required");

  return prisma.amendmentEventRecord.create({
    data: {
      entryId: input.entryId,
      segmentId: input.segmentId,
      amendmentPath: input.amendmentPath,
      amendmentType: input.amendmentType,
      requestedBy: input.requestedBy || actorId,
      authorisedBy: input.authorisedBy || actorId,
      authorityBasis: input.authorityBasis || "seed",
      reason: input.reason,
      priorTermsRef: input.priorTermsRef,
      newTermsSummary: input.newTermsSummary,
      folioLineId: input.folioLineId,
      stageAtAmendment: input.stageAtAmendment,
    },
  });
}

export async function roomChangeReEntryToS1(
  prisma: PrismaClient,
  actorId: string,
  input: { entryId: string; newRoomId: string; reason: string },
) {
  if (!input.newRoomId?.trim()) throw new ValidationError("newRoomId is required");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");

  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    include: {
      roomAssignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: true } },
      reservation: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS7ForRoomChangeReEntry({ currentStage: entry.currentStage });
  const currentAssignment = entry.roomAssignments[0];
  if (!currentAssignment) throw new ValidationError("Entry has no current room assignment");

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // AC-S7-22: compute consequences before any commit.
    await computeReEntryConsequences(tx as any, {
      entryId: input.entryId,
      fromStage: Stage.S7,
      toStage: Stage.S1,
      reason: input.reason,
      actorId,
    });

    const oldSeg = await tx.segment.findFirst({
      where: { entryId: input.entryId },
      orderBy: { segmentNumber: "desc" },
    });
    if (!oldSeg) throw new NotFoundError("Segment");

    // Seal prior segment and create new segment atomically.
    await tx.segment.update({ where: { id: oldSeg.id }, data: { sealedAt: now, sealedBy: actorId } });
    const newSeg = await tx.segment.create({
      data: { entryId: input.entryId, segmentNumber: entry.segmentNumber + 1, stage: Stage.S7, createdBy: actorId },
    });

    // Reservation is single-row per entry; link it to the new segment.
    if (entry.reservation) {
      await tx.reservation.update({ where: { id: entry.reservation.id }, data: { segmentId: newSeg.id } });
    }

    // Room claim state transitions must be atomic with segment write.
    await tx.room.update({
      where: { id: currentAssignment.roomId },
      data: { currentClaimState: InventoryClaimState.DEPARTED_DIRTY },
    });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: currentAssignment.roomId,
        entryId: input.entryId,
        fromState: InventoryClaimState.OCCUPIED,
        toState: InventoryClaimState.DEPARTED_DIRTY,
        actorId,
        reason: "S7 room change re-entry",
      },
    });

    await tx.room.update({ where: { id: input.newRoomId }, data: { currentClaimState: InventoryClaimState.OCCUPIED } });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: input.newRoomId,
        entryId: input.entryId,
        fromState: InventoryClaimState.CONFIRMED,
        toState: InventoryClaimState.OCCUPIED,
        actorId,
        reason: "S7 room change re-entry",
      },
    });

    await tx.roomAssignment.create({
      data: { entryId: input.entryId, roomId: input.newRoomId, assignedBy: actorId, deficientAtAssignment: false },
    });

    await tx.entry.update({
      where: { id: input.entryId },
      data: {
        segmentNumber: entry.segmentNumber + 1,
        currentStage: Stage.S1,
        version: { increment: 1 },
        updatedAt: now,
      },
    });

    await tx.amendmentEventRecord.create({
      data: {
        entryId: input.entryId,
        segmentId: newSeg.id,
        amendmentPath: "PATH_1",
        amendmentType: "ROOM_CHANGE",
        requestedBy: actorId,
        authorisedBy: actorId,
        authorityBasis: "S7 re-entry room change",
        reason: input.reason,
        newTermsSummary: `Room change from ${currentAssignment.room.roomNumber} to new room id ${input.newRoomId}`,
        stageAtAmendment: Stage.S7,
      },
    });

    return tx.entry.findUniqueOrThrow({ where: { id: input.entryId } });
  });
}

