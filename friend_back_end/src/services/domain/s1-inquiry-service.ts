import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceCustodianReassignmentAuthority } from "../../policies/02-ownership-custodian-assignment/p04-custodian-reassignment.js";
import { resolveInitialCustodianActorId } from "../../policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.js";
import * as duplicateDetectionService from "./duplicate-detection-service.js";
import * as auditService from "../infrastructure/audit-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { cascadeParkEntryTx, cascadeUnparkEntryTx } from "./s1-entry-service.js";

export async function createInquiry(
  prisma: PrismaClient,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    guestProfileId: string;
    sourceChannel: string;
    notes?: string;
    proposedCheckIn?: string;
    proposedCheckOut?: string;
    duplicateCheck?: { isDuplicate: boolean; conflictingInquiryId?: string };
    /** Phase C — optional FK to TravelAgent. Mutually exclusive with corporateAccountId. */
    travelAgentId?: string | null;
    /** Phase C — optional FK to CorporateAccount. Mutually exclusive with travelAgentId. */
    corporateAccountId?: string | null;
  },
) {
  if (!input.guestProfileId?.trim()) throw new ValidationError("guestProfileId is required");
  if (!input.sourceChannel?.trim()) throw new ValidationError("sourceChannel is required");

  const travelAgentId = input.travelAgentId?.trim() || null;
  const corporateAccountId = input.corporateAccountId?.trim() || null;
  if (travelAgentId && corporateAccountId) {
    throw new ValidationError("An inquiry can be linked to a travel agent OR a corporate account, not both");
  }
  if (travelAgentId) {
    const agent = await prisma.travelAgent.findUnique({ where: { id: travelAgentId } });
    if (!agent) throw new ValidationError(`Travel agent ${travelAgentId} not found`);
    if (!agent.isActive) throw new ValidationError(`Travel agent ${travelAgentId} is inactive`);
  }
  if (corporateAccountId) {
    const corp = await prisma.corporateAccount.findUnique({ where: { id: corporateAccountId } });
    if (!corp) throw new ValidationError(`Corporate account ${corporateAccountId} not found`);
    if (!corp.isActive) throw new ValidationError(`Corporate account ${corporateAccountId} is inactive`);
  }

  await duplicateDetectionService.assertInquiryNotConfirmedDuplicateForCreation(prisma, {
    guestProfileId: input.guestProfileId.trim(),
    proposedCheckIn: input.proposedCheckIn,
    proposedCheckOut: input.proposedCheckOut,
  });

  const custodian = await resolveInitialCustodianActorId(prisma, { sourceChannel: input.sourceChannel });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "INQUIRY" as const, now);
    const created = await tx.inquiry.create({
      data: {
        id,
        referenceNumber: id,
        guestProfileId: input.guestProfileId,
        sourceChannel: input.sourceChannel,
        defaultCustodianId: custodian,
        notes: input.notes?.trim() || null,
        travelAgentId,
        corporateAccountId,
        createdBy: actorId,
      },
    });

    if (input.duplicateCheck?.isDuplicate) {
      await duplicateDetectionService.maybeCreateDuplicateFlag(tx as any, {
        inquiryId: created.id,
        actorId,
        conflictingInquiryId: input.duplicateCheck.conflictingInquiryId ?? null,
      });
    }

    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "INQUIRY.CREATED",
      entityType: "Inquiry",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      inquiryId: created.id,
      payload: { inquiryId: created.id, sourceChannel: created.sourceChannel, guestProfileId: created.guestProfileId },
      createdBy: actorId,
    });

    return created;
  });
}

export async function assignInquiryCustodian(
  prisma: PrismaClient,
  inquiryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  newCustodianId: string,
) {
  if (!newCustodianId?.trim()) throw new ValidationError("newCustodianId is required");
  const staff = await prisma.staffUser.findUnique({ where: { id: newCustodianId.trim() } });
  if (!staff) throw new NotFoundError("StaffUser");

  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: { entries: { select: { useType: true, guestCount: true } } },
  });
  if (!inquiry) throw new NotFoundError("Inquiry");

  const useTypes = inquiry.entries.map((e) => e.useType);
  const maxGuests = inquiry.entries.reduce((m, e) => (typeof e.guestCount === "number" && e.guestCount > m ? e.guestCount! : m), 0);

  enforceCustodianReassignmentAuthority({
    actorLevel,
    useTypes,
    guestCount: maxGuests > 0 ? maxGuests : undefined,
  });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.inquiry.update({
      where: { id: inquiryId },
      data: { defaultCustodianId: newCustodianId.trim() },
    });
    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "INQUIRY.CUSTODIAN_REASSIGNED",
      entityType: "Inquiry",
      entityId: inquiryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId,
      payload: { newCustodianId: newCustodianId.trim() },
      createdBy: actorId,
    });
    return updated;
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
  await auditService.emit(prisma, { actorId, actorLevel: "L1" }, {
    eventType: "INQUIRY.CORPORATE_CONTEXT_CAPTURED",
    entityType: "Inquiry",
    entityId: inquiryId,
    operation: "UPDATE",
    timestamp: now,
    inquiryId,
    payload: { corporateClientRef: updated.corporateClientRef, corporateCoordinator: updated.corporateCoordinator },
    createdBy: actorId,
  });
  return updated;
}

export async function resolveDuplicateFlag(
  prisma: PrismaClient,
  flagId: string,
  actorId: string,
  input: { resolutionType: "MERGE" | "ACKNOWLEDGE" | "DISMISS"; resolutionReason?: string; mergedIntoInquiryId?: string },
) {
  return duplicateDetectionService.resolveDuplicateFlag(prisma, flagId, actorId, input);
}

/**
 * Inquiry-level park (SIG-S1 §3.3 / §6.2). Cascades to every ACTIVE non-terminal child entry,
 * parking each as a cascade (`parkedIndividually = false`) so an inquiry-level unpark can later
 * reverse exactly those. Entries already individually parked (`parkedIndividually = true`) are
 * skipped — not doubly-parked. Each affected entry gets the full park treatment (stage timer
 * cancelled, 30-day park-expiry armed) and its own ENTRY.PARKED trace.
 */
export async function parkInquiry(prisma: PrismaClient, inquiryId: string, actorId: string, reason?: string) {
  const trimmedReason = reason?.trim();
  if (!trimmedReason) throw new ValidationError("A reason is required to park an inquiry.");
  if (trimmedReason.length > 500) throw new ValidationError("Park reason must be 500 characters or fewer.");

  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { entries: true } });
  if (!inquiry) throw new NotFoundError("Inquiry");

  const targets = inquiry.entries.filter((e) => e.status === "ACTIVE");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const engine = await getTimerEngine();
    for (const e of targets) {
      await cascadeParkEntryTx(tx as any, engine, { id: e.id, currentStage: e.currentStage, inquiryId }, actorId, trimmedReason);
    }
    await tx.inquiry.update({ where: { id: inquiryId }, data: { parkedAt: now, parkedBy: actorId } });
    await auditService.emit(tx as any, { actorId, actorLevel: "L1" }, {
      eventType: "INQUIRY.PARKED",
      entityType: "Inquiry",
      entityId: inquiryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId,
      entryId: null,
      payload: { reason: trimmedReason, entriesParked: targets.length },
      createdBy: actorId,
    });
  });

  const refreshed = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
  return {
    id: inquiryId,
    referenceNumber: refreshed?.referenceNumber ?? null,
    parkedAt: refreshed?.parkedAt ?? null,
    parkedBy: refreshed?.parkedBy ?? null,
    entriesParked: targets.length,
  };
}

/**
 * Inquiry-level unpark (SIG-S1 §3.3 / §6.2). Reverses ONLY entries parked by the inquiry-level
 * cascade (`status = PARKED` AND `parkedIndividually = false`). Entries that were individually
 * parked before the cascade (`parkedIndividually = true`) remain parked. Each reversed entry gets
 * its park-expiry timer cancelled, the normal stage timer re-armed, and its own ENTRY.UNPARKED trace.
 */
export async function unparkInquiry(prisma: PrismaClient, inquiryId: string, actorId: string) {
  const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, include: { entries: true } });
  if (!inquiry) throw new NotFoundError("Inquiry");

  const targets = inquiry.entries.filter((e) => e.status === "PARKED" && e.parkedIndividually === false);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const engine = await getTimerEngine();
    for (const e of targets) {
      await cascadeUnparkEntryTx(tx as any, engine, { id: e.id, currentStage: e.currentStage, inquiryId }, actorId);
    }
    await tx.inquiry.update({ where: { id: inquiryId }, data: { parkedAt: null, parkedBy: null } });
    await auditService.emit(tx as any, { actorId, actorLevel: "L1" }, {
      eventType: "INQUIRY.UNPARKED",
      entityType: "Inquiry",
      entityId: inquiryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId,
      entryId: null,
      payload: { entriesUnparked: targets.length },
      createdBy: actorId,
    });
  });

  const refreshed = await prisma.inquiry.findUnique({ where: { id: inquiryId } });
  return {
    id: inquiryId,
    referenceNumber: refreshed?.referenceNumber ?? null,
    parkedAt: refreshed?.parkedAt ?? null,
    parkedBy: refreshed?.parkedBy ?? null,
    entriesUnparked: targets.length,
  };
}

const inquiryEntrySummarySelect = {
  id: true,
  currentStage: true,
  status: true,
  useType: true,
  guestCount: true,
  checkInDate: true,
  checkOutDate: true,
  segmentNumber: true,
  otaSource: true,
  createdAt: true,
} as const;

export async function listInquiries(prisma: PrismaClient, query: { limit: number; guestProfileId?: string }) {
  const where = query.guestProfileId?.trim() ? { guestProfileId: query.guestProfileId.trim() } : {};
  return prisma.inquiry.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    include: {
      guestProfile: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      },
      entries: { select: inquiryEntrySummarySelect },
    },
  });
}

export async function getInquiryById(prisma: PrismaClient, inquiryId: string) {
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: {
      entries: { select: inquiryEntrySummarySelect },
      guestProfile: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      duplicateFlags: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" } },
      travelAgent: { select: { id: true, displayName: true, modeOfContact: true, contactNumber: true, contactEmail: true } },
      corporateAccount: { select: { id: true, displayName: true, modeOfContact: true, contactNumber: true, contactEmail: true, gstNumber: true, billingAddress: true } },
    },
  });
  if (!inquiry) throw new NotFoundError("Inquiry");
  return inquiry;
}