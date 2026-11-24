import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { findSameGuestStays, type SameGuestWhy } from "../../lib/same-guest-stays.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import * as auditService from "../infrastructure/audit-service.js";

/**
 * "Is this the same booking entered twice?" — the question Wrap up raises (Policy 12's flag), set
 * out for the desk and answered there (2026-11-24, operator: "somewhere in the stages it tells the
 * user to acknowledge that it isn't a mistake and is another booking"). The flag held the move out
 * of Inquiry and Negotiation, but nothing on the desk could answer it.
 *
 * Both meant: the flag is answered ACKNOWLEDGE in the desk's name, and the booking moves on.
 * Entered twice: the desk cancels this inquiry with its own Cancel inquiry, which ends the booking.
 * Reserve asks the FOM again (Policy 13), as it always has for the same guest.
 */

const STAGE_WORD: Record<string, string> = {
  S1: "Inquiry",
  S2: "Negotiation",
  S3: "Set up",
  S4: "Reserve",
  S5: "Arrival",
  S6: "Check-in",
  S7: "Stay",
  S8: "Check-out",
  S9: "Closed",
};

export type DuplicateQuestion = {
  flagId: string;
  raisedAt: string;
  other: {
    entryId: string;
    inquiryId: string;
    guestName: string;
    checkInDate: string;
    checkOutDate: string;
    stageWord: string;
    parked: boolean;
    why: SameGuestWhy;
    partyName: string | null;
  } | null;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** The open questions on this booking's enquiry, each with the other booking it is about. */
export async function describeOpenDuplicates(prisma: PrismaClient, entryId: string): Promise<{ questions: DuplicateQuestion[] }> {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, inquiryId: true } });
  if (!entry) throw new NotFoundError("Entry");
  const flags = await prisma.duplicateDetectionFlag.findMany({
    where: { inquiryId: entry.inquiryId, status: "OPEN" },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, mergedIntoInquiryId: true },
  });
  if (!flags.length) return { questions: [] };
  const stays = await findSameGuestStays(prisma, entry.id);
  const questions: DuplicateQuestion[] = [];
  for (const f of flags) {
    const s = stays.find((x) => x.inquiryId === f.mergedIntoInquiryId) ?? null;
    let other: DuplicateQuestion["other"] = null;
    if (s) {
      other = {
        entryId: s.entryId,
        inquiryId: s.inquiryId,
        guestName: s.guestName,
        checkInDate: ymd(s.checkInDate),
        checkOutDate: ymd(s.checkOutDate),
        stageWord: STAGE_WORD[s.currentStage] ?? s.currentStage,
        parked: s.status === "PARKED",
        why: s.why,
        partyName: s.partyName,
      };
    } else if (f.mergedIntoInquiryId) {
      // The other booking no longer matches (its dates moved, it ended): still named, so the desk
      // can look at it before answering.
      const e = await prisma.entry.findFirst({
        where: { inquiryId: f.mergedIntoInquiryId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          inquiryId: true,
          checkInDate: true,
          checkOutDate: true,
          currentStage: true,
          status: true,
          guestProfile: { select: { title: true, firstName: true, lastName: true } },
        },
      });
      if (e?.checkInDate && e.checkOutDate) {
        other = {
          entryId: e.id,
          inquiryId: e.inquiryId,
          guestName: [e.guestProfile?.title, e.guestProfile?.firstName, e.guestProfile?.lastName].filter(Boolean).join(" "),
          checkInDate: ymd(e.checkInDate),
          checkOutDate: ymd(e.checkOutDate),
          stageWord: STAGE_WORD[e.currentStage] ?? e.currentStage,
          parked: e.status === "PARKED",
          why: "SAME_GUEST",
          partyName: null,
        };
      }
    }
    questions.push({ flagId: f.id, raisedAt: f.createdAt.toISOString(), other });
  }
  return { questions };
}

/** "Both are meant" — this booking is a second booking, not the same one entered twice. */
export async function answerBothMeant(
  prisma: PrismaClient,
  actor: { actorId: string; actorLevel: ActorLevel },
  entryId: string,
  flagId: string,
  note?: string | null,
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, inquiryId: true, status: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const flag = await prisma.duplicateDetectionFlag.findUnique({ where: { id: flagId } });
  if (!flag || flag.inquiryId !== entry.inquiryId) throw new ValidationError("That question is not on this booking");
  if (flag.status !== "OPEN") throw new ValidationError("That question has already been answered");
  const reason = note?.trim() ? `Both bookings are meant — ${note.trim()}` : "Both bookings are meant — not entered twice";
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.duplicateDetectionFlag.update({
      where: { id: flagId },
      data: { status: "RESOLVED", resolutionType: "ACKNOWLEDGE", resolutionReason: reason, resolvedAt: now, resolvedBy: actor.actorId },
    });
    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
      eventType: "INQUIRY.DUPLICATE_RESOLVED",
      entityType: "DuplicateDetectionFlag",
      entityId: flagId,
      operation: "UPDATE",
      timestamp: now,
      entryId: entry.id,
      inquiryId: entry.inquiryId,
      payload: { resolutionType: "ACKNOWLEDGE", resolutionReason: reason, conflictingInquiryId: flag.mergedIntoInquiryId },
    });
    return { flagId: updated.id, status: updated.status, reason };
  });
}
