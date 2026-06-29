import type { ActorLevel, Prisma, PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
export { autoFulfilS2ToS3, progressS1ToS2 } from "../../state-machines/s1-state-machine.js";
import * as auditService from "../infrastructure/audit-service.js";
import * as notificationService from "../infrastructure/notification-service.js";
import { enforceCustodianReassignmentAuthority } from "../../policies/02-ownership-custodian-assignment/p04-custodian-reassignment.js";
import { resolveGroupBillingModeFromGuestCount } from "../../policies/26-group-foc-billing/p64-group-detection-at-entry-creation.js";
import {
  enforceEntryActiveForPark,
  enforceEntryNotExpiredForS1Lifecycle,
  enforceEntryParkedForUnpark,
} from "../../policies/01-availability/p01-s1-entry-status-and-stage-gates.js";
import { enforceEntryParkAllowedForCurrentStage } from "../../policies/01-availability/p01-entry-park-allowed-stages.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";

export async function createEntry(
  prisma: PrismaClient,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    inquiryId: string;
    guestProfileId?: string;
    useType: string;
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    otaSource?: boolean;
    walkInCompressed?: boolean;
  },
) {
  if (!input.inquiryId?.trim()) throw new ValidationError("inquiryId is required");
  if (!input.useType?.trim()) throw new ValidationError("useType is required");
  const inquiry = await prisma.inquiry.findUnique({ where: { id: input.inquiryId } });
  if (!inquiry) throw new NotFoundError("Inquiry");

  // Policy registry override: `registry.groupDetection.guestCountThreshold` (when enabled)
  // takes precedence over the legacy `groupDetection.guestCountThreshold` ConfigurationEntry.
  const groupPolicy = await getRegistryPolicy(prisma, "registry.groupDetection.guestCountThreshold");
  const registryGroupThreshold =
    groupPolicy && groupPolicy.enabled !== false && typeof groupPolicy.count === "number"
      ? (groupPolicy.count as number)
      : null;
  const thresholdEntry = registryGroupThreshold === null ? await getActiveConfigEntry(prisma, "groupDetection.guestCountThreshold") : null;
  const thresholdRaw = thresholdEntry?.configValue;
  const threshold =
    registryGroupThreshold ??
    (typeof thresholdRaw === "number"
      ? thresholdRaw
      : typeof thresholdRaw === "string"
        ? Number(thresholdRaw)
        : Number.MAX_SAFE_INTEGER);
  const groupBillingMode = resolveGroupBillingModeFromGuestCount({
    guestCount: input.guestCount,
    threshold: Number.isFinite(threshold) ? threshold : Number.MAX_SAFE_INTEGER,
  });

  const checkInDate = input.checkInDate ? new Date(input.checkInDate) : null;
  const checkOutDate = input.checkOutDate ? new Date(input.checkOutDate) : null;

  // Child / capacity policy enforcement. Run BLOCK-severity issues as a hard reject at S1
  // intake — e.g. unaccompanied-minor, ratio violation, over-capacity vs a chosen room type.
  // When no roomTypeId is known yet (typical at S1 inquiry creation — type is picked at S2),
  // only composition-level checks run.
  if (input.childAges && input.childAges.length > 0) {
    const { issues } = await validateCapacity(prisma, {
      adults: input.adultCount ?? 0,
      childAges: input.childAges,
    });
    const blocking = issues.filter((i) => i.severity === "BLOCK");
    if (blocking.length > 0) {
      throw new ValidationError(blocking.map((i) => i.message).join(" "), { capacityIssues: blocking } as any);
    }
  }

  return prisma.$transaction(async (tx) => {
    const entryId = await allocateReadableId(tx, "ENTRY" as const);
    const entry = await tx.entry.create({
      data: {
        id: entryId,
        inquiryId: input.inquiryId,
        guestProfileId: input.guestProfileId ?? inquiry.guestProfileId ?? null,
        useType: input.useType as any,
        currentStage: Stage.S1,
        status: EntryStatus.ACTIVE,
        walkInCompressed: input.walkInCompressed === true,
        checkInDate: checkInDate && !Number.isNaN(checkInDate.getTime()) ? checkInDate : null,
        checkOutDate: checkOutDate && !Number.isNaN(checkOutDate.getTime()) ? checkOutDate : null,
        guestCount: input.guestCount ?? null,
        adultCount: input.adultCount ?? null,
        childCount: input.childCount ?? null,
        childAges: input.childAges ?? [],
        otaSource: input.otaSource === true,
        ...(groupBillingMode != null ? { groupBillingMode } : {}),
        createdBy: actorId,
      },
    });
    await tx.segment.create({
      data: { entryId: entry.id, segmentNumber: 1, stage: Stage.S1, createdBy: actorId },
    });
    const now = new Date();
    await tx.stageDwellRecord.create({ data: { entryId: entry.id, stage: Stage.S1, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any });
    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "ENTRY.CREATED",
      entityType: "Entry",
      entityId: entry.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: Stage.S1,
      inquiryId: entry.inquiryId,
      entryId: entry.id,
      payload: { entryId: entry.id, stage: "S1" },
      createdBy: actorId,
    });

    // Policy registry override: `registry.s1Expiry.minutes` takes precedence over the legacy
    // `expiry.s1.defaultTtlSeconds.DEFAULT` ConfigurationEntry. Set `enabled: false` to revert.
    const s1ExpiryPolicy = await getRegistryPolicy(tx as any, "registry.s1Expiry.minutes");
    const registryS1Seconds =
      s1ExpiryPolicy && s1ExpiryPolicy.enabled !== false && typeof s1ExpiryPolicy.minutes === "number"
        ? (s1ExpiryPolicy.minutes as number) * 60
        : null;
    let ttlSeconds: number;
    if (registryS1Seconds !== null) {
      ttlSeconds = registryS1Seconds;
    } else {
      const ttl = await requireActiveConfigValue<{ DEFAULT: number }>(tx as any, "expiry.s1.defaultTtlSeconds");
      ttlSeconds = Number(ttl.DEFAULT ?? 3600);
    }
    const dueAt = new Date(Date.now() + ttlSeconds * 1000);
    const engine = await getTimerEngine();
    const jobId = await engine.schedule("ENTRY_EXPIRY", { entryId: entry.id }, { startAfter: dueAt });
    await tx.timerRecord.create({
      data: {
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "ENTRY_EXPIRY",
        stageContext: Stage.S1,
        firesAt: dueAt,
        dueAt,
        status: "SCHEDULED",
        payload: { entryId: entry.id },
        pgBossJobId: jobId,
        createdBy: actorId,
      },
    });

    return entry;
  });
}

export async function parkEntry(prisma: PrismaClient, entryId: string, actorId: string, _reason?: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotExpiredForS1Lifecycle({ status: entry.status });
  enforceEntryActiveForPark({ status: entry.status });
  enforceEntryParkAllowedForCurrentStage({ currentStage: entry.currentStage });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.PARKED, parkedAt: new Date(), parkedBy: actorId, parkedIndividually: true, version: { increment: 1 } },
    });
    await auditService.emit(tx as any, { actorId, actorLevel: "L1" }, {
      eventType: "ENTRY.PARKED",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: updated.currentStage as any,
      inquiryId: updated.inquiryId,
      entryId,
      payload: {},
      createdBy: actorId,
    });
    return updated;
  });
}

/**
 * S1-scope correction path. Used by the booking flow's step-1 Edit. Only allows the field set the
 * front-desk operator can sensibly change before quotation: stay dates, head-count breakdown,
 * useType. Fails if the entry has already advanced past S1 (preventing silent re-pricing of
 * sealed-in quotations / holds downstream).
 */
export async function updateEntryIntakeFields(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    useType?: string;
    expectedVersion?: number;
  },
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S1) {
    throw new ValidationError(`Cannot edit intake fields — entry has advanced to ${entry.currentStage}. Use the stage-specific amendment flow.`);
  }
  if (input.expectedVersion != null && entry.version !== input.expectedVersion) {
    throw new ValidationError("version mismatch");
  }
  // Re-run capacity checks against the new composition (childAges may have changed).
  if (input.childAges && input.childAges.length > 0) {
    const { issues } = await validateCapacity(prisma, {
      adults: input.adultCount ?? entry.adultCount ?? 0,
      childAges: input.childAges,
    });
    const blocking = issues.filter((i) => i.severity === "BLOCK");
    if (blocking.length > 0) {
      throw new ValidationError(blocking.map((i) => i.message).join(" "), { capacityIssues: blocking } as any);
    }
  }
  const checkInDate = input.checkInDate ? new Date(input.checkInDate) : undefined;
  const checkOutDate = input.checkOutDate ? new Date(input.checkOutDate) : undefined;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: {
        ...(checkInDate && !Number.isNaN(checkInDate.getTime()) ? { checkInDate } : {}),
        ...(checkOutDate && !Number.isNaN(checkOutDate.getTime()) ? { checkOutDate } : {}),
        ...(input.guestCount != null ? { guestCount: input.guestCount } : {}),
        ...(input.adultCount != null ? { adultCount: input.adultCount } : {}),
        ...(input.childCount != null ? { childCount: input.childCount } : {}),
        ...(input.childAges ? { childAges: input.childAges } : {}),
        ...(input.useType ? { useType: input.useType as any } : {}),
        version: { increment: 1 },
      },
    });
    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "ENTRY.INTAKE_UPDATED",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: updated.currentStage as any,
      inquiryId: updated.inquiryId,
      entryId,
      payload: input,
      createdBy: actorId,
    });
    return updated;
  });
}

export async function unparkEntry(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotExpiredForS1Lifecycle({ status: entry.status });
  enforceEntryParkedForUnpark({ status: entry.status });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.ACTIVE, parkedAt: null, parkedBy: null, parkedIndividually: false, version: { increment: 1 } },
    });
    await auditService.emit(tx as any, { actorId, actorLevel: "L1" }, {
      eventType: "ENTRY.UNPARKED",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: updated.currentStage as any,
      inquiryId: updated.inquiryId,
      entryId,
      payload: {},
      createdBy: actorId,
    });

    // (Re-)register expiry timer on unpark (SIG-S1 §6.6 TimerManagementService).
    // Policy registry override: `registry.s1Expiry.minutes` takes precedence over the legacy
    // `expiry.s1.defaultTtlSeconds.DEFAULT` ConfigurationEntry. Set `enabled: false` to revert.
    const s1ExpiryPolicy = await getRegistryPolicy(tx as any, "registry.s1Expiry.minutes");
    const registryS1Seconds =
      s1ExpiryPolicy && s1ExpiryPolicy.enabled !== false && typeof s1ExpiryPolicy.minutes === "number"
        ? (s1ExpiryPolicy.minutes as number) * 60
        : null;
    let ttlSeconds: number;
    if (registryS1Seconds !== null) {
      ttlSeconds = registryS1Seconds;
    } else {
      const ttl = await requireActiveConfigValue<{ DEFAULT: number }>(tx as any, "expiry.s1.defaultTtlSeconds");
      ttlSeconds = Number(ttl.DEFAULT ?? 3600);
    }
    const dueAt = new Date(Date.now() + ttlSeconds * 1000);
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

export async function expireEntry(prisma: PrismaClient, entryId: string) {
  if (!entryId?.trim()) throw new ValidationError("entryId is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");

  if (entry.status === EntryStatus.EXPIRED || entry.status === EntryStatus.CANCELLED || entry.status === EntryStatus.CLOSED) {
    return { skipped: true, reason: "ALREADY_TERMINAL" } as const;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.entry.update({
      where: { id: entry.id },
      data: { status: EntryStatus.EXPIRED, closedAt: now, closedBy: "SYSTEM", version: { increment: 1 } },
    });
    await auditService.emit(tx as any, auditService.systemActor(), {
      eventType: "ENTRY.EXPIRED",
      entityType: "Entry",
      entityId: entry.id,
      operation: "TRANSITION",
      timestamp: now,
      stageContext: entry.currentStage as any,
      payload: { entryId: entry.id, fromStatus: entry.status, toStatus: "EXPIRED" },
      inquiryId: entry.inquiryId,
      entryId: entry.id,
      createdBy: "SYSTEM",
    });
  });

  await notificationService.dispatchOperatorExpiry(prisma, {
    entityType: "Entry",
    entityId: entry.id,
    entryId: entry.id,
    reason: "ENTRY_STAGE_TTL_EXPIRED",
  });

  return { skipped: false } as const;
}

export async function reassignCustodianByEntryId(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  newCustodianId: string,
  _reason: string,
) {
  if (!newCustodianId?.trim()) throw new ValidationError("newCustodianId is required");
  const staff = await prisma.staffUser.findUnique({ where: { id: newCustodianId.trim() } });
  if (!staff) throw new NotFoundError("StaffUser");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      inquiry: {
        include: { entries: { select: { useType: true, guestCount: true } } },
      },
    },
  });
  if (!entry?.inquiry) throw new NotFoundError("Entry");

  const useTypes = entry.inquiry.entries.map((e) => e.useType);
  const maxGuests = entry.inquiry.entries.reduce((m, e) => (typeof e.guestCount === "number" && e.guestCount > m ? e.guestCount! : m), 0);

  enforceCustodianReassignmentAuthority({
    actorLevel,
    useTypes,
    guestCount: maxGuests > 0 ? maxGuests : undefined,
  });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.inquiry.update({
      where: { id: entry.inquiryId },
      data: { defaultCustodianId: newCustodianId.trim() },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.CUSTODIAN_REASSIGNED_VIA_INQUIRY",
        actorId,
        actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { inquiryId: entry.inquiryId, newCustodianId: newCustodianId.trim() },
        createdBy: actorId,
      },
    });
    return tx.inquiry.findUniqueOrThrow({ where: { id: entry.inquiryId } });
  });
}

export async function listEntries(
  prisma: PrismaClient,
  query: { limit: number; inquiryId?: string; status?: EntryStatus; currentStage?: Stage },
) {
  const where: Prisma.EntryWhereInput = {};
  if (query.inquiryId?.trim()) where.inquiryId = query.inquiryId.trim();
  if (query.status) where.status = query.status;
  if (query.currentStage) where.currentStage = query.currentStage;

  return prisma.entry.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: query.limit,
    select: {
      id: true,
      inquiryId: true,
      segmentNumber: true,
      useType: true,
      status: true,
      currentStage: true,
      guestCount: true,
      checkInDate: true,
      checkOutDate: true,
      walkInCompressed: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      guestProfile: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      },
      inquiry: {
        select: {
          guestProfile: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      },
    },
  });
}

