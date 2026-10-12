import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { recordDuplicateDetectionFlagIfPresent } from "../../policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.js";
import * as auditService from "../infrastructure/audit-service.js";
import { assertCallerReachable, callerColumns, normaliseCaller, type CallerInput } from "./s1-inquiry-service.js";

/**
 * The caller and the guest staying (2026-10-12, operator, after the boss's journey mockup).
 *
 * The first section of an inquiry is the CALLER — whoever rang: the guest, an agency's person, a
 * company's assistant, a VIP's secretary. Their phone or email starts the inquiry; their name can
 * wait. The GUEST who is STAYING is named at Wrap up, once rooms are chosen: the caller by
 * default, or someone else. A booking cannot leave Inquiry without one (Policy 16).
 *
 * The caller lives on the enquiry, never on a guest record — an agency's person is not a guest of
 * the hotel, and a guest record made for them would surface as a "returning guest" forever.
 */

type Actor = { actorId: string; level: ActorLevel };

async function loadEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      guestProfileId: true,
      checkInDate: true,
      checkOutDate: true,
      inquiry: {
        select: {
          id: true,
          guestProfileId: true,
          sourceChannel: true,
          callerTitle: true,
          callerFirstName: true,
          callerLastName: true,
          callerPhone: true,
          callerEmail: true,
          callerOnWhatsApp: true,
          _count: { select: { entries: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/**
 * Fill in or correct the caller's details. Fields not sent keep what is on record; an empty
 * string clears one. The result must still reach someone (a phone or an email, not on an OTA).
 */
export async function updateEntryCaller(prisma: PrismaClient, actor: Actor, entryId: string, input: CallerInput) {
  const entry = await loadEntry(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const inq = entry.inquiry;
  const pick = <K extends keyof CallerInput>(k: K, current: CallerInput[K]) => (input[k] === undefined ? current : input[k]);
  const next = normaliseCaller({
    title: pick("title", inq.callerTitle),
    firstName: pick("firstName", inq.callerFirstName),
    lastName: pick("lastName", inq.callerLastName),
    phone: pick("phone", inq.callerPhone),
    email: pick("email", inq.callerEmail),
    onWhatsApp: pick("onWhatsApp", inq.callerOnWhatsApp),
  });
  assertCallerReachable(next, inq.sourceChannel);

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.inquiry.update({ where: { id: inq.id }, data: callerColumns(next) });
    const changed = (Object.keys(input) as Array<keyof CallerInput>).filter((k) => input[k] !== undefined);
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "INQUIRY.CALLER_UPDATED",
      entityType: "Inquiry",
      entityId: inq.id,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: inq.id,
      entryId: entry.id,
      // Field names only — the values are on the record.
      payload: { fields: changed },
    });
    return {
      caller: {
        title: updated.callerTitle,
        firstName: updated.callerFirstName,
        lastName: updated.callerLastName,
        phone: updated.callerPhone,
        email: updated.callerEmail,
        onWhatsApp: updated.callerOnWhatsApp,
      },
    };
  });
}

export type SetGuestInput =
  | { mode: "CALLER"; nationality?: string | null }
  | { mode: "EXISTING"; guestProfileId: string }
  | {
      mode: "NEW";
      title?: string | null;
      firstName: string;
      lastName: string;
      nationality?: string | null;
      phone?: string | null;
      email?: string | null;
    };

/**
 * Name the guest who is staying: the caller (a guest record made from the caller's name and
 * contact), a guest already on file, or someone new. Inquiry only — once the booking moves on,
 * the quote, the bill and every paper carry this name. A guest already named can be replaced.
 *
 * The duplicate check (Policy 12) runs here, since this is when the guest becomes known: an
 * overlapping stay for the same guest on another enquiry is FLAGGED on this one, and the exit
 * gate then treats it as it treats a flag raised at intake.
 */
export async function setEntryGuest(prisma: PrismaClient, actor: Actor, entryId: string, input: SetGuestInput) {
  const entry = await loadEntry(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (entry.currentStage !== "S1") {
    throw new ValidationError("The guest staying is named at Inquiry — this booking has moved on");
  }
  const inq = entry.inquiry;
  const t = (v: string | null | undefined) => v?.trim() || null;

  let existingId: string | null = null;
  let create: { firstName: string; lastName: string; nationality: string | null; phone: string | null; email: string | null } | null = null;
  if (input.mode === "EXISTING") {
    const g = await prisma.guestProfile.findUnique({ where: { id: input.guestProfileId }, select: { id: true, isActive: true } });
    if (!g || !g.isActive) throw new ValidationError("That guest is not on file");
    existingId = g.id;
  } else if (input.mode === "CALLER") {
    if (!inq.callerFirstName || !inq.callerLastName) {
      throw new ValidationError("Take the caller's first and last name first — the guest record is made from them");
    }
    create = {
      firstName: inq.callerFirstName,
      lastName: inq.callerLastName,
      nationality: t(input.nationality),
      phone: inq.callerPhone,
      email: inq.callerEmail,
    };
  } else {
    const firstName = t(input.firstName);
    const lastName = t(input.lastName);
    if (!firstName || !lastName) throw new ValidationError("The guest's first and last name are needed");
    const email = t(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("The guest's email does not read as an email address");
    create = { firstName, lastName, nationality: t(input.nationality), phone: t(input.phone), email };
  }

  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    let guestProfileId = existingId;
    if (create) {
      const g = await tx.guestProfile.create({
        data: { ...create, clientTier: "STANDARD", createdBy: actor.actorId },
        select: { id: true },
      });
      guestProfileId = g.id;
      await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
        eventType: "GUEST_PROFILE.CREATED",
        entityType: "GuestProfile",
        entityId: g.id,
        operation: "CREATE",
        timestamp: now,
        payload: { guestProfileId: g.id, from: input.mode === "CALLER" ? "CALLER" : "WRAP_UP" },
      });
    }
    await tx.entry.update({ where: { id: entry.id }, data: { guestProfileId } });
    // The enquiry carries the guest too. It follows this booking when it had none, or when it was
    // this booking's earlier guest — a return stay on the same enquiry keeps whatever it names.
    const followInquiry = !inq.guestProfileId || inq.guestProfileId === entry.guestProfileId || inq._count.entries === 1;
    if (followInquiry) await tx.inquiry.update({ where: { id: inq.id }, data: { guestProfileId } });

    let duplicate: { conflictingInquiryId: string; conflictingEntryId: string } | null = null;
    if (entry.checkInDate && entry.checkOutDate) {
      const clash = await tx.entry.findFirst({
        where: {
          guestProfileId,
          id: { not: entry.id },
          inquiryId: { not: inq.id },
          status: { in: ["ACTIVE", "PARKED"] },
          checkInDate: { lt: entry.checkOutDate },
          checkOutDate: { gt: entry.checkInDate },
        },
        select: { id: true, inquiryId: true },
      });
      if (clash) {
        duplicate = { conflictingInquiryId: clash.inquiryId, conflictingEntryId: clash.id };
        await recordDuplicateDetectionFlagIfPresent(tx as any, {
          inquiryId: inq.id,
          actorId: actor.actorId,
          conflictingInquiryId: clash.inquiryId,
        });
      }
    }

    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.level }, {
      eventType: "ENTRY.GUEST_NAMED",
      entityType: "Entry",
      entityId: entry.id,
      operation: "UPDATE",
      timestamp: now,
      entryId: entry.id,
      inquiryId: inq.id,
      payload: { mode: input.mode, guestProfileId, previousGuestProfileId: entry.guestProfileId, duplicate },
    });
    return { guestProfileId: guestProfileId!, duplicate };
  });
  return outcome;
}
