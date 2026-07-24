import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { validateFoc } from "../../engines/foc-validation-engine.js";

export async function enforceFocValidationForCommittedHold(
  prisma: PrismaClient,
  input: { entryId: string; useType: string; isFoc: boolean; roomsRequested: number; focRoomsRequested: number },
) {
  if (!input.isFoc) return;
  if (!(input.useType === "GROUP" || input.useType === "CONFERENCE")) return;

  const result = await validateFoc(prisma, {
    entryId: input.entryId,
    roomsRequested: input.roomsRequested,
    focRoomsRequested: input.focRoomsRequested,
  });
  if (!result.isValid) {
    throw new PolicyGateBlockedError("FOC_INVALID", `FOC validation failed: ${result.reasons.join(", ")}`);
  }

  const approval = await prisma.traceEvent.findFirst({
    where: { eventType: "FOC.GM_APPROVED", entityType: "Entry", entityId: input.entryId },
    orderBy: { timestamp: "desc" },
  });
  if (!approval) {
    throw new PolicyGateBlockedError("FOC_GM_APPROVAL_REQUIRED", "GM approval required for FOC inclusion");
  }
}

