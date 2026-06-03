import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  enforceDeficientAcknowledgementsWhenRequiredForS1Exit,
  enforcePreferredAvailabilityConfigurationNotStaleForS1Exit,
  enforcePreferredAvailabilityConfigurationSelectedForS1Exit,
  enforceSelectedRoomNotMaintenanceOrBlockedForS1Exit,
} from "../policies/01-availability/p01-s1-exit-preferred-configuration-and-room-eligibility.js";
import { enforceNoOpenDuplicateFlagsForS1Exit } from "../policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s1-exit.js";
import {
  enforceGuestCountPresentForS1Exit,
  enforceGuestProfileLinkedForS1Exit,
  enforceGuestProfilePrimaryContactForS1Exit,
  enforceStayDatesPresentForS1Exit,
  enforceUseTypePresentForS1Exit,
} from "../policies/06-guest-identity/p16-s1-exit-entry-and-contact-gates.js";
import { enforceCorporateOrGovernmentInquiryContextForS1Exit } from "../policies/07-guest-data-governance/p17-corporate-government-inquiry-context-s1-exit.js";
import { enforceApartmentCommercialFieldsForS1Exit } from "../policies/13-billing-model/p33-apartment-commercial-fields-s1-exit.js";
import { enforceConferenceSpaceAllocationForS1Exit } from "../policies/27-work-order/p67-conference-s1-exit-space-gates.js";
import { enforceEntryAtS1ForAutoFulfilS2ToS3 } from "../policies/01-availability/p01-entry-at-s1-for-auto-fulfil-s2-to-s3.js";
import { enforceEntryAtS1ForS1ToS2Progression } from "../policies/01-availability/p01-s1-entry-status-and-stage-gates.js";
import { scheduleS2StageDwellWarningMonitor } from "../lib/schedule-s2-dwell-warning-monitor.js";

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
  enforceEntryAtS1ForS1ToS2Progression({ status: entry.status, currentStage: entry.currentStage });
  if (clientVersion == null) throw new ValidationError("version is required");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  enforceGuestProfileLinkedForS1Exit({ guestProfileId: entry.guestProfileId });
  enforceUseTypePresentForS1Exit({ useType: entry.useType });
  enforceGuestCountPresentForS1Exit({ guestCount: entry.guestCount });
  enforceStayDatesPresentForS1Exit({ checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate });

  const gp = entry.guestProfile;
  enforceGuestProfilePrimaryContactForS1Exit({ email: gp?.email, phone: gp?.phone });

  await enforceNoOpenDuplicateFlagsForS1Exit(prisma, { duplicateFlags: (entry.inquiry as any)?.duplicateFlags });

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

  const updated = await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.availabilityConfiguration.update({ where: { id: preferred.id }, data: { sealedAt: now } });
    const s1Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S1, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s1Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s1Dwell.id },
        data: {
          exitedAt: now,
          dwellSeconds: Math.max(0, Math.floor((now.getTime() - s1Dwell.enteredAt.getTime()) / 1000)),
        },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S2, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any,
    });

    const next = await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S2, version: { increment: 1 } } });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.STAGE_TRANSITION",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S1,
        inquiryId: next.inquiryId,
        entryId,
        payload: { from: "S1", to: "S2" },
        createdBy: actorId,
      },
    });
    return next;
  });

  await scheduleS2StageDwellWarningMonitor(prisma, entryId, actorId);

  return updated;
}

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

