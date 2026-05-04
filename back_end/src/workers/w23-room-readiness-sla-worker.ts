import type { PrismaClient } from "@prisma/client";
import { RoomPhysicalState, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import * as suggestionEngine from "../engines/room-assignment-suggestion-engine.js";

export async function runRoomReadinessSlaWorker(
  prisma: PrismaClient,
  _engine: TimerEngine,
  input: { entryId?: string; roomId?: string; phase?: "WARNING" | "BREACH"; timerRecordId?: string },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  const roomId = typeof input.roomId === "string" ? input.roomId : undefined;
  if (!entryId || !roomId) return { skipped: true, reason: "MISSING_IDS" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;
  if (entry.currentStage !== Stage.S5 && entry.currentStage !== Stage.S6) return { skipped: true, reason: "NOT_AT_S5_S6" } as const;

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return { skipped: true, reason: "ROOM_NOT_FOUND" } as const;

  const isReady = room.physicalState === RoomPhysicalState.AVAILABLE_CLEAN || room.physicalState === RoomPhysicalState.AVAILABLE_INSPECTED;
  if (isReady) return { skipped: true, reason: "ROOM_READY" } as const;

  const phase = input.phase === "BREACH" ? "BREACH" : "WARNING";
  const eventType = phase === "BREACH" ? "ROOM_READINESS_SLA.BREACHED" : "ROOM_READINESS_SLA.WARNING_FIRED";
  const suggestions = phase === "BREACH" ? await suggestionEngine.suggestRoomsForEntry(prisma, entryId) : [];

  await prisma.$transaction(async (tx) => {
    await tx.traceEvent.create({
      data: {
        eventType,
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Room",
        entityId: roomId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S5,
        inquiryId: null,
        entryId,
        payload: {
          entryId,
          roomId,
          roomNumber: room.roomNumber,
          physicalState: room.physicalState,
          phase,
          suggestions,
        },
        createdBy: "SYSTEM",
      },
    });
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }
  });

  return { skipped: false, entryId, roomId, phase } as const;
}

