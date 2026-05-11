import type { PrismaClient } from "@prisma/client";
import { SpaceAllocationState } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceConferenceSpaceAttendeeCapacity } from "../../policies/27-work-order/p67-conference-s1-exit-space-gates.js";
import { enforceEntryAtS1ForConferenceSpaceAllocation } from "../../policies/01-availability/p01-entry-at-s1-for-conference-space-allocation.js";

export async function allocateConferenceSpace(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: { spaceCode: string; attendeeCount: number; seatingConfig: string },
) {
  if (!input.spaceCode?.trim()) throw new ValidationError("spaceCode is required");
  const attendeeCount = Number(input.attendeeCount);
  if (!Number.isFinite(attendeeCount) || attendeeCount < 1) throw new ValidationError("attendeeCount must be >= 1");
  if (!input.seatingConfig?.trim()) throw new ValidationError("seatingConfig is required");

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS1ForConferenceSpaceAllocation({ currentStage: entry.currentStage });

  const segmentId = entry.segments[0]?.id ?? null;
  const space = await prisma.space.findUnique({ where: { code: input.spaceCode.trim() } });
  if (!space) throw new NotFoundError("Space");

  const cap = Number(space.capacity ?? space.defaultCapacity ?? 0);
  enforceConferenceSpaceAttendeeCapacity({ attendeeCount, capacity: cap });

  return prisma.$transaction(async (tx) => {
    return tx.spaceAllocation.create({
      data: {
        spaceId: space.id,
        entryId,
        segmentId,
        state: SpaceAllocationState.QUOTED,
        eventBlock: { attendeeCount, seatingConfig: input.seatingConfig.trim() } as any,
        createdBy: actorId,
      },
    });
  });
}

