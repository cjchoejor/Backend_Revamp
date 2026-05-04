import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

export type DisputeGateResult = "CLEAR" | "BLOCKED" | "BLOCKED_WITH_OVERRIDE_AVAILABLE";

export async function canProgressStage(prisma: PrismaClient, entryId: string, targetStage: Stage) {
  const open = await prisma.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!open) return { result: "CLEAR" as const, overrideAvailable: false as const };

  // At S7→S8, override can be available; at S8→S9 it is never available.
  if (targetStage === Stage.S8) return { result: "BLOCKED_WITH_OVERRIDE_AVAILABLE" as const, overrideAvailable: true as const };
  if (targetStage === Stage.S9) return { result: "BLOCKED" as const, overrideAvailable: false as const };
  return { result: "BLOCKED" as const, overrideAvailable: false as const };
}

