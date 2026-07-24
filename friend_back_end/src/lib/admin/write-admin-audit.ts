import type { Prisma } from "@prisma/client";
import { ActorLevel } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export async function writeAdminAuditEvent(
  tx: Tx,
  input: {
    actorId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    operation: "CREATE" | "UPDATE" | "DELETE";
    payload: Record<string, unknown>;
    requestId?: string;
  },
) {
  await tx.traceEvent.create({
    data: {
      eventType: input.eventType,
      actorId: input.actorId,
      actorLevel: ActorLevel.L4,
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      payload: {
        ...input.payload,
        requestId: input.requestId ?? null,
        surface: "AdminConsole",
      } as Prisma.InputJsonValue,
      timestamp: new Date(),
      createdBy: input.actorId,
    },
  });
}
