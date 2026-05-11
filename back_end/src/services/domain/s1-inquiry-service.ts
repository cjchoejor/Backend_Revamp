import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { resolveInitialCustodianActorId } from "../../policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.js";
import { recordDuplicateDetectionFlagIfPresent } from "../../policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.js";

function randomRef() {
  return `INQ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export async function createInquiry(
  prisma: PrismaClient,
  actorId: string,
  input: {
    guestProfileId: string;
    sourceChannel: string;
    notes?: string;
    duplicateCheck?: { isDuplicate: boolean; conflictingInquiryId?: string };
  },
) {
  if (!input.guestProfileId?.trim()) throw new ValidationError("guestProfileId is required");
  if (!input.sourceChannel?.trim()) throw new ValidationError("sourceChannel is required");

  // Policy 3 — initial custodian assignment.
  const custodian = await resolveInitialCustodianActorId(prisma, { sourceChannel: input.sourceChannel });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const created = await tx.inquiry.create({
      data: {
        referenceNumber: randomRef(),
        guestProfileId: input.guestProfileId,
        sourceChannel: input.sourceChannel,
        defaultCustodianId: custodian,
        notes: input.notes?.trim() || null,
        createdBy: actorId,
      },
    });

    if (input.duplicateCheck?.isDuplicate) {
      // Policy 12 — duplicate detection flag creation.
      await recordDuplicateDetectionFlagIfPresent(tx as any, {
        inquiryId: created.id,
        actorId,
        conflictingInquiryId: input.duplicateCheck.conflictingInquiryId ?? null,
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "INQUIRY.CREATED",
        actorId,
        actorLevel: "L1",
        entityType: "Inquiry",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        inquiryId: created.id,
        payload: { inquiryId: created.id, sourceChannel: created.sourceChannel, guestProfileId: created.guestProfileId },
        createdBy: actorId,
      },
    });

    return created;
  });
}

export async function captureCorporateContext(
  prisma: PrismaClient,
  inquiryId: string,
  actorId: string,
  input: { corporateClientRef: string; corporateCoordinator: string },
) {
  if (!input.corporateClientRef?.trim()) throw new ValidationError("corporateClientRef is required");
  if (!input.corporateCoordinator?.trim()) throw new ValidationError("corporateCoordinator is required");
  const now = new Date();
  const updated = await prisma.inquiry.update({
    where: { id: inquiryId },
    data: {
      corporateClientRef: input.corporateClientRef.trim(),
      corporateCoordinator: input.corporateCoordinator.trim(),
      corporateContextCapturedAt: now,
      corporateContextCapturedBy: actorId,
    } as any,
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "INQUIRY.CORPORATE_CONTEXT_CAPTURED",
      actorId,
      actorLevel: "L1",
      entityType: "Inquiry",
      entityId: inquiryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId,
      payload: { corporateClientRef: updated.corporateClientRef, corporateCoordinator: updated.corporateCoordinator },
      createdBy: actorId,
    },
  });
  return updated;
}

export async function resolveDuplicateFlag(
  prisma: PrismaClient,
  flagId: string,
  actorId: string,
  input: { resolutionType: "MERGE" | "ACKNOWLEDGE" | "DISMISS"; resolutionReason?: string; mergedIntoInquiryId?: string },
) {
  if (!input.resolutionType) throw new ValidationError("resolutionType is required");
  const now = new Date();
  const flag = await (prisma as any).duplicateDetectionFlag.findUnique({ where: { id: flagId } });
  if (!flag) throw new ValidationError("DuplicateDetectionFlag not found");
  if (flag.status !== "OPEN") throw new ValidationError("DuplicateDetectionFlag is not OPEN");

  const updated = await (prisma as any).duplicateDetectionFlag.update({
    where: { id: flagId },
    data: {
      status: "RESOLVED",
      resolutionType: input.resolutionType,
      resolutionReason: input.resolutionReason?.trim?.() || null,
      mergedIntoInquiryId: input.mergedIntoInquiryId?.trim?.() || flag.mergedIntoInquiryId || null,
      resolvedAt: now,
      resolvedBy: actorId,
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "INQUIRY.DUPLICATE_RESOLVED",
      actorId,
      actorLevel: "L1",
      entityType: "DuplicateDetectionFlag",
      entityId: flagId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: updated.inquiryId,
      payload: { resolutionType: updated.resolutionType, resolutionReason: updated.resolutionReason, mergedIntoInquiryId: updated.mergedIntoInquiryId },
      createdBy: actorId,
    },
  });
  return updated;
}

export async function parkInquiry(prisma: PrismaClient, inquiryId: string, actorId: string, reason?: string) {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { entries: true } });
  if (!inquiry) throw new ValidationError("Inquiry not found");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.entry.updateMany({
      where: { inquiryId, status: "ACTIVE" },
      data: { status: "PARKED", parkedAt: now, parkedBy: actorId, parkedIndividually: false, version: { increment: 1 } } as any,
    });
    await tx.traceEvent.create({
      data: {
        eventType: "INQUIRY.PARKED",
        actorId,
        actorLevel: "L1",
        entityType: "Inquiry",
        entityId: inquiryId,
        operation: "UPDATE",
        timestamp: now,
        inquiryId,
        entryId: null,
        payload: { reason: typeof reason === "string" ? reason : null },
        createdBy: actorId,
      },
    });
  });
  return { ok: true } as const;
}

export async function unparkInquiry(prisma: PrismaClient, inquiryId: string, actorId: string) {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
  if (!inquiry) throw new ValidationError("Inquiry not found");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Only unpark entries that were parked via inquiry-level park cascade (parkedIndividually=false).
    await tx.entry.updateMany({
      where: { inquiryId, status: "PARKED", parkedIndividually: false },
      data: { status: "ACTIVE", parkedAt: null, parkedBy: null, version: { increment: 1 } } as any,
    });
    await tx.traceEvent.create({
      data: {
        eventType: "INQUIRY.UNPARKED",
        actorId,
        actorLevel: "L1",
        entityType: "Inquiry",
        entityId: inquiryId,
        operation: "UPDATE",
        timestamp: now,
        inquiryId,
        entryId: null,
        payload: {},
        createdBy: actorId,
      },
    });
  });
  return { ok: true } as const;
}

