import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

export type DisputeGateResult = "CLEAR" | "BLOCKED" | "BLOCKED_WITH_OVERRIDE_AVAILABLE";

export async function canProgressStage(prisma: PrismaClient, entryId: string, targetStage: Stage) {
  const open = await prisma.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!open) return { result: "CLEAR" as const, overrideAvailable: false as const };

  if (targetStage === Stage.S8) {
    const override = await prisma.disputeGateOverrideRecord.findFirst({
      where: { disputeId: open.id, targetStage: Stage.S8 },
      orderBy: { createdAt: "desc" },
    });
    if (override) return { result: "CLEAR" as const, overrideAvailable: false as const };
    return { result: "BLOCKED_WITH_OVERRIDE_AVAILABLE" as const, overrideAvailable: true as const };
  }

  // S8→S9: no override path; any non-terminal dispute blocks.
  if (targetStage === Stage.S9) return { result: "BLOCKED" as const, overrideAvailable: false as const };
  return { result: "BLOCKED" as const, overrideAvailable: false as const };
}

