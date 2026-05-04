import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../lib/errors.js";

export async function recordCancellationDisclosure(
  prisma: PrismaClient,
  input: { entryId: string; segmentId: string; noShowTreatmentStatement: string; disclosedTerms?: unknown },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  if (!input.noShowTreatmentStatement?.trim()) {
    throw new PolicyGateBlockedError("MISSING_NO_SHOW_TREATMENT", "noShowTreatmentStatement is required");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const rec = await tx.cancellationDisclosureRecord.upsert({
      where: { entryId: input.entryId },
      create: {
        entryId: input.entryId,
        segmentId: input.segmentId,
        noShowTreatmentStatement: input.noShowTreatmentStatement.trim(),
        disclosedTerms: (input.disclosedTerms ?? {}) as any,
        disclosedAt: now,
        disclosedBy: actor.actorId,
      },
      update: {
        segmentId: input.segmentId,
        noShowTreatmentStatement: input.noShowTreatmentStatement.trim(),
        disclosedTerms: (input.disclosedTerms ?? {}) as any,
        disclosedAt: now,
        disclosedBy: actor.actorId,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "CANCELLATION_DISCLOSURE.RECORDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CancellationDisclosureRecord",
        entityId: rec.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: { entryId: input.entryId, segmentId: input.segmentId },
        createdBy: actor.actorId,
      },
    });

    return rec;
  });
}

