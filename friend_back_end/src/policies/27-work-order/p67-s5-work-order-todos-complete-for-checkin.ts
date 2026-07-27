import type { PrismaClient } from "@prisma/client";
import { EntryUseType, WorkOrderToDoStatus } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S5 Policy 67 slice — conference/group pre-arrival: no pending work-order to-dos before S5→S6.
 */
export async function enforceConferenceGroupWorkOrderTodosCompleteForS5ToS6(
  prisma: PrismaClient,
  input: { entryId: string; useType: EntryUseType },
) {
  if (input.useType !== EntryUseType.CONFERENCE && input.useType !== EntryUseType.GROUP) return;

  const pending = await prisma.workOrderToDoItem.count({
    where: {
      status: WorkOrderToDoStatus.PENDING,
      workOrder: { entryId: input.entryId },
    },
  });
  if (pending === 0) return;

  throw new StageGateBlockedError(
    "Open work-order to-do items must be completed, cancelled with reason, or governed-deferred before check-in",
    "WORK_ORDER_TODOS_PENDING",
  );
}
