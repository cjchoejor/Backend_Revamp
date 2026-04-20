import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { NotFoundError, StageGateBlockedError } from "../lib/errors.js";

/** Minimal S5 cancellation stub — full Policy 35 penalty flow belongs in a dedicated cancellation module. */
export async function cancelEntryAtS5(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S5) {
    throw new StageGateBlockedError("Cancellation at this route is only supported for entries at S5", "NOT_AT_S5");
  }
  return prisma.entry.update({
    where: { id: entryId },
    data: {
      status: EntryStatus.CANCELLED,
      closedAt: new Date(),
      closedBy: actorId,
      version: { increment: 1 },
    },
  });
}
