import type { Prisma, PrismaClient } from "@prisma/client";

type AuditActor = { actorId: string; actorLevel: string };

type AuditEmitInput = {
  eventType: string;
  entityType: string;
  entityId: string;
  operation: string;
  timestamp: Date;
  payload: Prisma.InputJsonValue;
  stageContext?: string | null;
  segmentContext?: string | null;
  correlationId?: string | null;
  inquiryId?: string | null;
  entryId?: string | null;
  createdBy?: string | null;
};

export function systemActor(): AuditActor {
  return { actorId: "SYSTEM", actorLevel: "SYSTEM" };
}

export async function emit(prisma: PrismaClient, actor: AuditActor, input: AuditEmitInput) {
  return prisma.traceEvent.create({
    data: {
      eventType: input.eventType,
      actorId: actor.actorId,
      actorLevel: actor.actorLevel as any,
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      payload: input.payload as any,
      timestamp: input.timestamp,
      stageContext: (input.stageContext ?? null) as any,
      segmentContext: input.segmentContext ?? null,
      correlationId: input.correlationId ?? null,
      inquiryId: input.inquiryId ?? null,
      entryId: input.entryId ?? null,
      createdBy: input.createdBy ?? actor.actorId,
    } as any,
  });
}

