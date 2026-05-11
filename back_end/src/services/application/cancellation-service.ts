import type { PrismaClient } from "@prisma/client";
import { EntryStatus } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { enforceEntryAtS5ForS5CancellationRoute } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

/** Minimal S5 cancellation stub — full Policy 35 penalty flow belongs in a dedicated cancellation module. */
export async function cancelEntryAtS5(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS5ForS5CancellationRoute({ currentStage: entry.currentStage });
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
