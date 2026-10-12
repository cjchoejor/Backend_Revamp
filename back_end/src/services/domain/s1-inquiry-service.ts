import type { ActorLevel, PrismaClient } from "@prisma/client";
import { AppError, AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceCustodianReassignmentAuthority } from "../../policies/02-ownership-custodian-assignment/p04-custodian-reassignment.js";
import { resolveInitialCustodianActorId } from "../../policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.js";
import * as duplicateDetectionService from "./duplicate-detection-service.js";
import * as auditService from "../infrastructure/audit-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { cascadeParkEntryTx, cascadeUnparkEntryTx } from "./s1-entry-service.js";
import { resolveInquiryChannel } from "../../lib/inquiry-came-in-as.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import {
  isEntryParkAllowedForStage,
  isEntryStatusParkable,
} from "../../policies/01-availability/p01-entry-park-allowed-stages.js";

export async function createInquiry(
  prisma: PrismaClient,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    /** The guest STAYING, when already known (a returning caller found on file). Optional since
     *  2026-10-12 — the guest is usually named at Wrap up. */
    guestProfileId?: string | null;
    /** Who called. A phone or an email is needed unless the booking came from an OTA. */
    caller?: CallerInput | null;
    sourceChannel?: string;
    /** How the guest came in — the channel follows from it (lib/inquiry-came-in-as). */
    cameInAs?: string;
    notes?: string;
    proposedCheckIn?: string;
    proposedCheckOut?: string;
    duplicateCheck?: { isDuplicate: boolean; conflictingInquiryId?: string };
    duplicateResolution?: { resolution: "ACKNOWLEDGE" | "DISMISS"; reason: string };
    /** Phase C — optional FK to TravelAgent. Mutually exclusive with corporateAccountId. */
    travelAgentId?: string | null;
    /** Phase C — optional FK to CorporateAccount. Mutually exclusive with travelAgentId. */
    corporateAccountId?: string | null;
    /**
     * Which negotiated package this booking is quoted on. Optional: when omitted, pricing
     * resolves the party's default package, then the COMMON one. Must belong to the party named
     * above — a package from a different agency would price the wrong rate.
     */
    ratePackageId?: string | null;
  },
) {
  // The channel and the finer came-in-as, validated together; an old-style caller sending only
  // the channel (+ the notes marker) still gets the column filled.
  const channel = resolveInquiryChannel({ cameInAs: input.cameInAs, sourceChannel: input.sourceChannel, notes: input.notes });
  const guestProfileId = input.guestProfileId?.trim() || null;
  if (guestProfileId) {
    const g = await prisma.guestProfile.findUnique({ where: { id: guestProfileId }, select: { id: true } });
    if (!g) throw new ValidationError(`Guest profile ${guestProfileId} not found`);
  }
  // The caller (2026-10-12): someone must be reachable from the first call — a phone or an
  // email — except on an OTA booking, which comes through the OTA. A booking with a known guest
  // and no caller block is the older API shape and stays accepted.
  const caller = normaliseCaller(input.caller);
  if (input.caller || !guestProfileId) assertCallerReachable(caller, channel.sourceChannel);

  const { travelAgentId, corporateAccountId, ratePackageId } = await validateInquiryParty(prisma, input);

  // Policy 12 (SIG-S1 §6.1): a confirmed duplicate blocks creation until the FOM resolves it —
  // the operator sees the conflicting booking, and the FOM either goes ahead with a recorded
  // reason (a deliberate second booking: another room for the same guest, the tour leader's own
  // night) or records that it is not a true duplicate. The spec's resolution paths existed only
  // as a flag nothing could create while the block fired, so a deliberate second booking for a
  // guest could not be entered at all (2026-09-18). Merging into the existing inquiry is not built.
  const dup = input.duplicateResolution ?? null;
  if (dup) {
    if (!(actorLevel === "L2" || actorLevel === "L3" || actorLevel === "L4")) {
      throw new AuthorizationError("A confirmed duplicate is the FOM's to resolve");
    }
    if (!dup.reason?.trim()) throw new ValidationError("Say why this booking goes ahead");
  }
  let resolvedConflict: { conflictingInquiryId: string | null; conflictingEntryId: string | null } | null = null;
  try {
    if (guestProfileId) await duplicateDetectionService.assertInquiryNotConfirmedDuplicateForCreation(prisma, {
      guestProfileId,
      proposedCheckIn: input.proposedCheckIn,
      proposedCheckOut: input.proposedCheckOut,
    });
  } catch (e) {
    const body = e instanceof AppError ? (e.body as { blockingCondition?: string; details?: { conflictingInquiryId?: string; conflictingEntryId?: string } }) : null;
    if (!dup || body?.blockingCondition !== "DUPLICATE_INQUIRY_CONFIRMED") throw e;
    resolvedConflict = { conflictingInquiryId: body.details?.conflictingInquiryId ?? null, conflictingEntryId: body.details?.conflictingEntryId ?? null };
  }

  const custodian = await resolveInitialCustodianActorId(prisma, { sourceChannel: channel.sourceChannel });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "INQUIRY" as const, now);
    const created = await tx.inquiry.create({
      data: {
        id,
        referenceNumber: id,
        guestProfileId,
        ...callerColumns(caller),
        sourceChannel: channel.sourceChannel,
        cameInAs: channel.cameInAs,
        defaultCustodianId: custodian,
        notes: input.notes?.trim() || null,
        travelAgentId,
        corporateAccountId,
        ratePackageId,
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

    // The FOM's resolution of the confirmed duplicate, on record: the flag, resolved at once.
    if (resolvedConflict && dup) {
      const flag = await tx.duplicateDetectionFlag.create({
        data: {
          inquiryId: created.id,
          status: "RESOLVED",
          resolutionType: dup.resolution,
          resolutionReason: dup.reason.trim(),
          mergedIntoInquiryId: null,
          createdBy: actorId,
          resolvedAt: now,
          resolvedBy: actorId,
        },
      });
      await auditService.emit(tx as any, { actorId, actorLevel }, {
        eventType: "INQUIRY.DUPLICATE_RESOLVED",
        entityType: "DuplicateDetectionFlag",
        entityId: flag.id,
        operation: "CREATE",
        timestamp: now,
        inquiryId: created.id,
        payload: {
          resolutionType: dup.resolution,
          resolutionReason: dup.reason.trim(),
          conflictingInquiryId: resolvedConflict.conflictingInquiryId,
          conflictingEntryId: resolvedConflict.conflictingEntryId,
          atCreation: true,
        },
        createdBy: actorId,
      });
    }

    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "INQUIRY.CREATED",
      entityType: "Inquiry",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      inquiryId: created.id,
      payload: { inquiryId: created.id, sourceChannel: created.sourceChannel, cameInAs: created.cameInAs, guestProfileId: created.guestProfileId },
      createdBy: actorId,
    });

    return created;
  });
}

/**
 * Who booked, checked: at most one of an agency or a company, active, and a package that belongs
 * to that party. Shared by the intake and by a change to "who is asking" at Inquiry (2026-10-12).
 */
export async function validateInquiryParty(
  prisma: PrismaClient,
  input: { travelAgentId?: string | null; corporateAccountId?: string | null; ratePackageId?: string | null },
) {
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

  // A package must belong to the party it is being quoted for. Without this check a booking
  // could carry another agency's package and be priced on their negotiated rate.
  const ratePackageId = input.ratePackageId?.trim() || null;
  if (ratePackageId) {
    const pkg = await prisma.ratePackage.findUnique({
      where: { id: ratePackageId },
      select: { id: true, name: true, travelAgentId: true, corporateAccountId: true, scope: true, effectiveTo: true },
    });
    if (!pkg) throw new ValidationError(`Rate package ${ratePackageId} not found`);
    if (pkg.effectiveTo && pkg.effectiveTo <= new Date()) {
      throw new ValidationError(`Rate package "${pkg.name}" is no longer active`);
    }
    if (!travelAgentId && !corporateAccountId) {
      throw new ValidationError("A rate package can only be chosen for a travel agent or corporate booking");
    }
    const belongs =
      (travelAgentId && pkg.travelAgentId === travelAgentId) ||
      (corporateAccountId && pkg.corporateAccountId === corporateAccountId);
    if (!belongs) {
      throw new ValidationError(`Rate package "${pkg.name}" does not belong to the selected party`);
    }
  }

  return { travelAgentId, corporateAccountId, ratePackageId };
}

/* ------------------------------------------------------------------ the caller */

export type CallerInput = {
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  onWhatsApp?: boolean | null;
};
type Caller = { title: string | null; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; onWhatsApp: boolean | null };

function normaliseCaller(c: CallerInput | null | undefined): Caller {
  const t = (v: string | null | undefined) => v?.trim() || null;
  const phone = t(c?.phone);
  return {
    title: t(c?.title),
    firstName: t(c?.firstName),
    lastName: t(c?.lastName),
    phone,
    email: t(c?.email),
    // "On WhatsApp?" is a question about a number; with no number it has no answer.
    onWhatsApp: phone ? (c?.onWhatsApp ?? null) : null,
  };
}

/** A phone or an email (not on an OTA booking), and "on WhatsApp?" answered for a phone. */
export function assertCallerReachable(c: Caller, sourceChannel: string | null | undefined) {
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
    throw new ValidationError("The caller's email does not read as an email address");
  }
  if (!c.phone && !c.email && sourceChannel !== "OTA") {
    throw new ValidationError("Take the caller's phone or email — one of the two is needed to start the inquiry");
  }
  if (c.phone && c.onWhatsApp == null) {
    throw new ValidationError("Ask whether the caller's number is on WhatsApp");
  }
}

function callerColumns(c: Caller) {
  return {
    callerTitle: c.title,
    callerFirstName: c.firstName,
    callerLastName: c.lastName,
    callerPhone: c.phone,
    callerEmail: c.email,
    callerOnWhatsApp: c.onWhatsApp,
  };
}

export { normaliseCaller, callerColumns };

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

/**
 * Edit the inquiry's free-text special-preference note in place — stage-agnostic (L1+, any stage),
 * so the desk can add/update the guest's special preference from any step of the journey. Reuses
 * `Inquiry.notes` (the intake note); an empty string clears it. Overwrites rather than appends so
 * the preference is never duplicated.
 */
export async function updateInquiryNotes(prisma: PrismaClient, inquiryId: string, actorId: string, notes: string) {
  const existing = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    select: { id: true, entries: { select: { status: true } } },
  });
  if (!existing) throw new NotFoundError("Inquiry");
  // A sealed record is read-only (2026-09-18): once every booking on the inquiry is closed,
  // cancelled or expired, the preference that travelled with them is part of the record. An
  // inquiry with no booking yet, or with one still live, stays editable.
  const live = existing.entries.filter((e) => e.status === "ACTIVE" || e.status === "PARKED");
  if (existing.entries.length > 0 && live.length === 0) {
    enforceEntryNotSealedForWorkingAction({ status: existing.entries[0].status });
  }
  const trimmed = notes.trim();
  const now = new Date();
  const updated = await prisma.inquiry.update({
    where: { id: inquiryId },
    data: { notes: trimmed.length ? trimmed : null },
  });
  await auditService.emit(prisma, { actorId, actorLevel: "L1" }, {
    eventType: "INQUIRY.SPECIAL_PREFERENCE_UPDATED",
    entityType: "Inquiry",
    entityId: inquiryId,
    operation: "UPDATE",
    timestamp: now,
    inquiryId,
    payload: { notesLength: trimmed.length },
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

  // Same eligibility rule as the entry-level route (`parkEntry`) — one source of truth, so the
  // cascade can never park an entry the direct route would refuse. Ineligible children are SKIPPED
  // rather than failing the whole inquiry park: one out-of-scope sibling must not block pausing
  // the rest. `skipped` is reported back and traced so the operator sees what was left running.
  const eligible = inquiry.entries.filter(
    (e) => isEntryStatusParkable(e.status) && isEntryParkAllowedForStage(e.currentStage),
  );
  const skipped = inquiry.entries
    .filter((e) => isEntryStatusParkable(e.status) && !isEntryParkAllowedForStage(e.currentStage))
    .map((e) => ({ entryId: e.id, currentStage: e.currentStage }));
  const targets = eligible;
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
      payload: { reason: trimmedReason, entriesParked: targets.length, entriesSkipped: skipped },
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
    entriesSkipped: skipped,
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
      travelAgent: { select: { id: true, displayName: true, modeOfContact: true, contactNumbers: true, contactEmail: true } },
      corporateAccount: { select: { id: true, displayName: true, modeOfContact: true, contactNumbers: true, contactEmail: true, gstNumber: true, billingAddress: true } },
    },
  });
  if (!inquiry) throw new NotFoundError("Inquiry");
  return inquiry;
}