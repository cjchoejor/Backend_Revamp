import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { detectOverbooking } from "../../engines/overbooking-detection-engine.js";

export async function enforceOverbookingRequiresGmMitigationBeforeConfirmation(
  prisma: PrismaClient,
  input: { entryId: string; otaSource: boolean },
) {
  const over = await detectOverbooking(prisma, { entryId: input.entryId, otaSource: input.otaSource });
  if (!over.overbookingDetected) return;

  const existing = await prisma.otaConflictOverbookingRecord.findUnique({ where: { entryId: input.entryId } }).catch(() => null);
  if (!existing || !existing.gmApprovalActorId || existing.mitigationPlanStatus === "OPEN") {
    throw new PolicyGateBlockedError(
      "OVERBOOKING_REQUIRES_GM",
      `Overbooking detected (${over.triggerType}): GM approval + mitigation required before confirmation`,
    );
  }
}

