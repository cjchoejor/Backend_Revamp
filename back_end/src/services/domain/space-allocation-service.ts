import type { Prisma, PrismaClient } from "@prisma/client";
import { SpaceAllocationState, type Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceConferenceSpaceAttendeeCapacity } from "../../policies/27-work-order/p67-conference-s1-exit-space-gates.js";
import { enforceEntryAtS1ForConferenceSpaceAllocation } from "../../policies/01-availability/p01-entry-at-s1-for-conference-space-allocation.js";
import { assertSpaceTurnaroundBufferAllowsQuotedAllocation } from "../../policies/27-work-order/p67-space-turnaround-buffer.js";

export const CONFERENCE_LIKE_USE_TYPES = ["CONFERENCE", "CATERING"] as const;

export function isConferenceLikeUseType(useType: string): boolean {
  return useType === "CONFERENCE" || useType === "CATERING";
}

/** Marks prior availability-query QUOTED allocations for this entry+segment so a new search can replace them. */
export async function releaseAvailabilityQueryQuotedAllocations(
  tx: Prisma.TransactionClient,
  entryId: string,
  segmentId: string | null,
) {
  const candidates = await tx.spaceAllocation.findMany({
    where: {
      entryId,
      state: SpaceAllocationState.QUOTED,
      segmentId: segmentId === null ? null : segmentId,
    },
  });
  const ids = candidates.filter((c) => (c.eventBlock as { source?: string })?.source === "AVAILABILITY_QUERY").map((c) => c.id);
  if (ids.length === 0) return;
  await tx.spaceAllocation.updateMany({
    where: { id: { in: ids } },
    data: { state: SpaceAllocationState.RELEASED },
  });
}

/**
 * Creates a **QUOTED** `SpaceAllocation` in the same transaction as availability configuration (SIG-S1 §6.5).
 * Caller must persist `AvailabilityConfiguration` in the same `tx` before or after as required.
 */
export async function createQuotedSpaceAllocationForAvailabilityQuery(
  tx: Prisma.TransactionClient,
  params: {
    entryId: string;
    segmentId: string | null;
    spaceId: string;
    windowStart: Date;
    windowEnd: Date;
    attendeeCount: number;
    seatingConfig: string;
    actorId: string;
    bufferMinutes: number;
    currentStage: Stage;
  },
) {
  enforceEntryAtS1ForConferenceSpaceAllocation({ currentStage: params.currentStage });

  const space = await tx.space.findUnique({ where: { id: params.spaceId } });
  if (!space) throw new NotFoundError("Space");

  const cap = Number(space.capacity ?? space.defaultCapacity ?? 0);
  enforceConferenceSpaceAttendeeCapacity({ attendeeCount: params.attendeeCount, capacity: cap });

  await releaseAvailabilityQueryQuotedAllocations(tx, params.entryId, params.segmentId);

  await assertSpaceTurnaroundBufferAllowsQuotedAllocation(tx, {
    spaceId: params.spaceId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    bufferMs: Math.max(0, Math.floor(params.bufferMinutes * 60_000)),
  });

  return tx.spaceAllocation.create({
    data: {
      spaceId: params.spaceId,
      entryId: params.entryId,
      segmentId: params.segmentId,
      state: SpaceAllocationState.QUOTED,
      eventBlock: {
        source: "AVAILABILITY_QUERY",
        attendeeCount: params.attendeeCount,
        seatingConfig: params.seatingConfig,
        checkInDate: params.windowStart.toISOString(),
        checkOutDate: params.windowEnd.toISOString(),
      } as any,
      createdBy: params.actorId,
    },
  });
}

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

