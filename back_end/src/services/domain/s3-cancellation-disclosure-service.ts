import type { Prisma, PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { enforceNoShowTreatmentStatementPresent } from "../../policies/14-cancellation/p34-no-show-treatment-statement-required.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { cancellationPolicySnapshot, policyInTerms } from "../../lib/cancellation-policy.js";

/**
 * The terms with the hotel's cancellation policy kept on them (2026-11-10): the setting as it is
 * now, so the guest pays what they were told even if the setting changes later. Terms that already
 * carry a policy (a booking split off another) keep theirs.
 */
async function withPolicyKept(db: Prisma.TransactionClient | PrismaClient, terms: unknown, now: Date): Promise<Record<string, unknown>> {
  const base = terms && typeof terms === "object" && !Array.isArray(terms) ? { ...(terms as Record<string, unknown>) } : {};
  if (policyInTerms(base)) return base;
  const setting = (await getActiveConfigEntry(db as PrismaClient, "cancellation.policyTiers"))?.configValue ?? null;
  const policy = cancellationPolicySnapshot(setting, now);
  return policy ? { ...base, policy } : base;
}

/** What a no-show costs, as Set up has always recorded it. */
export const DEFAULT_NO_SHOW_STATEMENT = "No-show: one night room charge plus applicable taxes.";

/**
 * The terms recorded by the system when a booking reaches Set up (2026-11-05, operator: "from the
 * backend, record that the terms were disclosed for now for whenever a booking reaches step up, in
 * the future we will implement it properly so that user have to do it manually"). Once per booking,
 * and never over a record that exists: the record survives a re-entry, as it always has.
 *
 * The record says it was the system: `disclosedBy` SYSTEM, its own trace. Nobody at the desk told
 * the guest anything by this. A booking split off another keeps that booking's terms.
 */
export async function ensureCancellationDisclosedTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; segmentId: string; now: Date },
) {
  const existing = await tx.cancellationDisclosureRecord.findUnique({ where: { entryId: input.entryId } });
  if (existing) return existing;
  const entry = await tx.entry.findUnique({ where: { id: input.entryId }, select: { inquiryId: true, carryOver: true } });
  const carried = (entry?.carryOver as { cancellation?: { noShowTreatmentStatement?: unknown; disclosedTerms?: unknown } | null } | null)?.cancellation ?? null;
  const statement = typeof carried?.noShowTreatmentStatement === "string" ? carried.noShowTreatmentStatement.trim() : "";
  const terms = await withPolicyKept(tx, carried?.disclosedTerms ?? { tier: "DEFAULT" }, input.now);
  const rec = await tx.cancellationDisclosureRecord.create({
    data: {
      entryId: input.entryId,
      segmentId: input.segmentId,
      noShowTreatmentStatement: statement || DEFAULT_NO_SHOW_STATEMENT,
      disclosedTerms: terms as Prisma.InputJsonValue,
      disclosedAt: input.now,
      disclosedBy: "SYSTEM",
    },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "CANCELLATION_DISCLOSURE.AUTO_RECORDED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "CancellationDisclosureRecord",
      entityId: rec.id,
      operation: "CREATE",
      timestamp: input.now,
      stageContext: Stage.S3,
      inquiryId: entry?.inquiryId ?? null,
      entryId: input.entryId,
      payload: { entryId: input.entryId, segmentId: input.segmentId, auto: true, cause: "REACHED_SET_UP", carried: !!carried, policyKept: !!terms.policy },
      createdBy: "SYSTEM",
    },
  });
  return rec;
}

export async function recordCancellationDisclosure(
  prisma: PrismaClient,
  input: { entryId: string; segmentId: string; noShowTreatmentStatement: string; disclosedTerms?: unknown },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  enforceNoShowTreatmentStatementPresent({ noShowTreatmentStatement: input.noShowTreatmentStatement });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const terms = await withPolicyKept(tx, input.disclosedTerms, now);
    const rec = await tx.cancellationDisclosureRecord.upsert({
      where: { entryId: input.entryId },
      create: {
        entryId: input.entryId,
        segmentId: input.segmentId,
        noShowTreatmentStatement: input.noShowTreatmentStatement.trim(),
        disclosedTerms: terms as Prisma.InputJsonValue,
        disclosedAt: now,
        disclosedBy: actor.actorId,
      },
      update: {
        segmentId: input.segmentId,
        noShowTreatmentStatement: input.noShowTreatmentStatement.trim(),
        disclosedTerms: terms as Prisma.InputJsonValue,
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

