import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceEntryAtS1ForAutoFulfilS2ToS3 } from "../../policies/01-availability/p01-entry-at-s1-for-auto-fulfil-s2-to-s3.js";
import {
  enforceDeficientAcknowledgementsWhenRequiredForS1Exit,
  enforcePreferredAvailabilityConfigurationNotStaleForS1Exit,
  enforcePreferredAvailabilityConfigurationSelectedForS1Exit,
  enforceSelectedRoomNotMaintenanceOrBlockedForS1Exit,
} from "../../policies/01-availability/p01-s1-exit-preferred-configuration-and-room-eligibility.js";
import { enforceNoOpenDuplicateFlagsForS1Exit } from "../../policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s1-exit.js";
import {
  enforceGuestCountPresentForS1Exit,
  enforceGuestProfileLinkedForS1Exit,
  enforceGuestProfilePrimaryContactForS1Exit,
  enforceStayDatesPresentForS1Exit,
  enforceUseTypePresentForS1Exit,
} from "../../policies/06-guest-identity/p16-s1-exit-entry-and-contact-gates.js";
import { enforceCorporateOrGovernmentInquiryContextForS1Exit } from "../../policies/07-guest-data-governance/p17-corporate-government-inquiry-context-s1-exit.js";
import { enforceApartmentCommercialFieldsForS1Exit } from "../../policies/13-billing-model/p33-apartment-commercial-fields-s1-exit.js";
import { enforceConferenceSpaceAllocationForS1Exit } from "../../policies/27-work-order/p67-conference-s1-exit-space-gates.js";

export async function createEntry(
  prisma: PrismaClient,
  actorId: string,
  input: {
    inquiryId: string;
    guestProfileId?: string;
    useType: string;
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    otaSource?: boolean;
    walkInCompressed?: boolean;
  },
) {
  if (!input.inquiryId?.trim()) throw new ValidationError("inquiryId is required");
  if (!input.useType?.trim()) throw new ValidationError("useType is required");
  const inquiry = await prisma.inquiry.findUnique({ where: { id: input.inquiryId } });
  if (!inquiry) throw new NotFoundError("Inquiry");

  const checkInDate = input.checkInDate ? new Date(input.checkInDate) : null;
  const checkOutDate = input.checkOutDate ? new Date(input.checkOutDate) : null;

  return prisma.$transaction(async (tx) => {
    const entry = await tx.entry.create({
      data: {
        inquiryId: input.inquiryId,
        guestProfileId: input.guestProfileId ?? inquiry.guestProfileId ?? null,
        useType: input.useType as any,
        currentStage: Stage.S1,
        status: EntryStatus.ACTIVE,
        walkInCompressed: input.walkInCompressed === true,
        checkInDate: checkInDate && !Number.isNaN(checkInDate.getTime()) ? checkInDate : null,
        checkOutDate: checkOutDate && !Number.isNaN(checkOutDate.getTime()) ? checkOutDate : null,
        guestCount: input.guestCount ?? null,
        otaSource: input.otaSource === true,
        createdBy: actorId,
      },
    });
    await tx.segment.create({
      data: { entryId: entry.id, segmentNumber: 1, stage: Stage.S1, createdBy: actorId },
    });
    const now = new Date();
    await tx.stageDwellRecord.create({ data: { entryId: entry.id, stage: Stage.S1, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.CREATED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entry.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S1,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, stage: "S1" },
        createdBy: actorId,
      },
    });
    return entry;
  });
}

export async function parkEntry(prisma: PrismaClient, entryId: string, actorId: string, _reason?: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if ((entry.status as any) === "EXPIRED") throw new StateTransitionError("Entry is EXPIRED");
  if (entry.status !== EntryStatus.ACTIVE) throw new StateTransitionError("Entry must be ACTIVE to park");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.PARKED, parkedAt: new Date(), parkedBy: actorId, parkedIndividually: true, version: { increment: 1 } },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.PARKED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: updated.currentStage,
        inquiryId: updated.inquiryId,
        entryId,
        payload: {},
        createdBy: actorId,
      },
    });
    return updated;
  });
}

export async function unparkEntry(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if ((entry.status as any) === "EXPIRED") throw new StateTransitionError("Entry is EXPIRED");
  if (entry.status !== EntryStatus.PARKED) throw new StateTransitionError("Entry must be PARKED to unpark");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.ACTIVE, parkedAt: null, parkedBy: null, parkedIndividually: false, version: { increment: 1 } },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.UNPARKED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: updated.currentStage,
        inquiryId: updated.inquiryId,
        entryId,
        payload: {},
        createdBy: actorId,
      },
    });

    // (Re-)register expiry timer on unpark (SIG-S1 §6.6 TimerManagementService).
    const ttl = await requireActiveConfigValue<{ DEFAULT: number }>(tx as any, "expiry.s1.defaultTtlSeconds");
    const dueAt = new Date(Date.now() + Number(ttl.DEFAULT ?? 3600) * 1000);
    const engine = await getTimerEngine();
    const jobId = await engine.schedule("ENTRY_EXPIRY", { entryId }, { startAfter: dueAt });
    await tx.timerRecord.create({
      data: {
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "ENTRY_EXPIRY",
        stageContext: updated.currentStage,
        firesAt: dueAt,
        dueAt,
        status: "SCHEDULED",
        payload: { entryId },
        pgBossJobId: jobId,
        createdBy: actorId,
      },
    });
    return updated;
  });
}

export async function progressS1ToS2(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      inquiry: { include: { duplicateFlags: true } as any },
      availabilityConfigs: { orderBy: { createdAt: "desc" } },
      guestProfile: true,
      spaceAllocations: { include: { space: true } } as any,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if ((entry.status as any) === "EXPIRED") throw new StateTransitionError("Entry is EXPIRED");
  if (entry.currentStage !== Stage.S1) throw new StateTransitionError("Entry is not at S1");
  if (clientVersion == null) throw new ValidationError("version is required");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  // Exit guard (partial, schema-backed): mandatory entry fields.
  enforceGuestProfileLinkedForS1Exit({ guestProfileId: entry.guestProfileId });
  enforceUseTypePresentForS1Exit({ useType: entry.useType });
  enforceGuestCountPresentForS1Exit({ guestCount: entry.guestCount });
  enforceStayDatesPresentForS1Exit({ checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate });

  const gp = entry.guestProfile;
  enforceGuestProfilePrimaryContactForS1Exit({ email: gp?.email, phone: gp?.phone });

  enforceNoOpenDuplicateFlagsForS1Exit({ duplicateFlags: (entry.inquiry as any)?.duplicateFlags });

  const inq: any = entry.inquiry;
  enforceCorporateOrGovernmentInquiryContextForS1Exit({
    sourceChannel: inq?.sourceChannel,
    corporateClientRef: inq?.corporateClientRef,
    corporateCoordinator: inq?.corporateCoordinator,
  });

  enforceApartmentCommercialFieldsForS1Exit({
    useType: String(entry.useType),
    apartmentDurationNights: entry.apartmentDurationNights,
    apartmentRateTierCode: entry.apartmentRateTierCode,
  });

  const preferredCfg = entry.availabilityConfigs.find((c) => c.optionSelected != null);
  enforcePreferredAvailabilityConfigurationSelectedForS1Exit({ preferred: preferredCfg });
  const preferred = preferredCfg!;
  enforcePreferredAvailabilityConfigurationNotStaleForS1Exit({ isStale: preferred.isStale });
  enforceDeficientAcknowledgementsWhenRequiredForS1Exit({
    optionSelected: preferred.optionSelected,
    deficientAcknowledgements: preferred.deficientAcknowledgements,
  });

  const selected = preferred.optionSelected as any;
  const rs: any = preferred.resultSet ?? {};
  enforceSelectedRoomNotMaintenanceOrBlockedForS1Exit({ selectedRoomId: selected?.roomId, resultSet: rs });

  enforceConferenceSpaceAllocationForS1Exit({
    useType: String(entry.useType),
    spaceAllocations: (entry.spaceAllocations as any[]) ?? [],
  });

  return prisma.$transaction(async (tx) => {
    await tx.availabilityConfiguration.update({ where: { id: preferred.id }, data: { sealedAt: new Date() } });
    const updated = await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S2, version: { increment: 1 } } });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.STAGE_TRANSITION",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: new Date(),
        stageContext: Stage.S1,
        inquiryId: updated.inquiryId,
        entryId,
        payload: { from: "S1", to: "S2" },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

// SIG-S2: S2 auto-fulfilment (compressed S1→S3 with evidence).
export async function autoFulfilS2ToS3(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { availabilityConfigs: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS1ForAutoFulfilS2ToS3({ currentStage: entry.currentStage });
  if (clientVersion == null) throw new ValidationError("version is required");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  const preferredCfg = entry.availabilityConfigs.find((c) => c.optionSelected != null);
  enforcePreferredAvailabilityConfigurationSelectedForS1Exit({ preferred: preferredCfg });
  const preferred = preferredCfg!;
  enforcePreferredAvailabilityConfigurationNotStaleForS1Exit({ isStale: preferred.isStale });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S3, version: { increment: 1 } } });
    await tx.traceEvent.create({
      data: {
        eventType: "S2.AUTO_FULFILLED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: updated.inquiryId,
        entryId,
        payload: { entryId, from: "S1", to: "S3", mode: "AUTO_FULFILLED", availabilityConfigurationId: preferred.id },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

