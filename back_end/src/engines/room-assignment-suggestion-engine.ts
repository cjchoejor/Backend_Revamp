import type { PrismaClient } from "@prisma/client";
import { RoomPhysicalState, Stage } from "@prisma/client";

export type RoomSuggestion = {
  roomId: string;
  roomNumber: string;
  physicalState: RoomPhysicalState;
  isDeficient: boolean;
  deficientCategory: string | null;
  matchScore: number;
};

export async function suggestRoomsForEntry(prisma: PrismaClient, entryId: string): Promise<RoomSuggestion[]> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { committedHold: true, reservation: true },
  });
  if (!entry || !entry.committedHold) return [];

  // S5-only advisory engine (SIG-S5 §5.2).
  if (entry.currentStage !== Stage.S5 && entry.currentStage !== Stage.S6) return [];

  const arrival = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? new Date();

  const rooms = await prisma.room.findMany({
    where: { roomTypeId: entry.committedHold.roomTypeId },
    orderBy: [{ physicalState: "asc" }, { roomNumber: "asc" }],
    take: 25,
  });

  // Simple ranking heuristic: ready rooms first, then scheduled maintenance ready by arrival, then others.
  const scored = rooms.map((r) => {
    const isReady =
      r.physicalState === RoomPhysicalState.AVAILABLE_CLEAN || r.physicalState === RoomPhysicalState.AVAILABLE_INSPECTED;
    const isScheduledOk =
      r.physicalState === RoomPhysicalState.UNDER_MAINTENANCE && r.expectedReadyAt != null && r.expectedReadyAt <= arrival;

    const base = isReady ? 100 : isScheduledOk ? 70 : 10;
    const penalty = r.isDeficient ? 30 : 0;
    return {
      roomId: r.id,
      roomNumber: r.roomNumber,
      physicalState: r.physicalState,
      isDeficient: !!r.isDeficient,
      deficientCategory: (r as any).deficientConditionCategory ?? null,
      matchScore: Math.max(0, base - penalty),
    } satisfies RoomSuggestion;
  });

  return scored.sort((a, b) => b.matchScore - a.matchScore);
}

