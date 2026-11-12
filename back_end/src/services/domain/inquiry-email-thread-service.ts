/**
 * THE GUEST'S OWN EMAIL ON AN ENQUIRY (2026-11-12) — the conversation every paper replies inside.
 *
 * The desk picks the email the guest or the agency wrote from the hotel's mailbox; the enquiry
 * keeps its Message-ID, subject, sender and References. From then on every email of every stay on
 * the enquiry (quotation, proforma, voucher, bills, the trip's papers) goes out as a reply to it —
 * `sendEmail` in email-service reads it — and the papers' default address is whoever wrote it
 * (`resolveSendTo`). The conversation belongs to the ENQUIRY, so a trip's two stays share it.
 */
import type { PrismaClient } from "@prisma/client";
import * as auditService from "../infrastructure/audit-service.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { forgetInboxList, readInboxEmailInFull } from "../infrastructure/mail-inbox-service.js";
import { recordFirstEmail, removeFirstEmail } from "./guest-email-conversation-service.js";

type Actor = { actorId: string; level: string };

const ENDED = new Set(["CANCELLED", "EXPIRED", "CLOSED"]);

export type EmailThreadSummary = {
  messageId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  linkedAt: string | null;
  linkedBy: string | null;
};

export function describeEmailThread(inq: {
  emailThreadMessageId: string | null;
  emailThreadSubject: string | null;
  emailThreadFrom: string | null;
  emailThreadFromName: string | null;
  emailThreadReceivedAt: Date | null;
  emailThreadLinkedAt: Date | null;
  emailThreadLinkedBy: string | null;
}): EmailThreadSummary | null {
  if (!inq.emailThreadMessageId) return null;
  return {
    messageId: inq.emailThreadMessageId,
    subject: inq.emailThreadSubject ?? "(no subject)",
    fromName: inq.emailThreadFromName,
    fromAddress: inq.emailThreadFrom,
    receivedAt: inq.emailThreadReceivedAt?.toISOString() ?? null,
    linkedAt: inq.emailThreadLinkedAt?.toISOString() ?? null,
    linkedBy: inq.emailThreadLinkedBy,
  };
}

async function loadInquiry(prisma: PrismaClient, inquiryId: string) {
  const inq = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    select: {
      id: true,
      emailThreadMessageId: true,
      emailThreadSubject: true,
      emailThreadFrom: true,
      emailThreadFromName: true,
      emailThreadReceivedAt: true,
      emailThreadLinkedAt: true,
      emailThreadLinkedBy: true,
      entries: { select: { id: true, status: true } },
    },
  });
  if (!inq) throw new NotFoundError("Inquiry");
  const live = inq.entries.filter((e) => !ENDED.has(e.status));
  if (inq.entries.length && !live.length) {
    throw new ValidationError("Every booking on this enquiry has ended — there are no papers left to send");
  }
  return { inq, live };
}

async function traceOnStays(
  prisma: PrismaClient,
  actor: Actor,
  inquiryId: string,
  stayIds: string[],
  eventType: string,
  payload: Record<string, unknown>,
) {
  const now = new Date();
  for (const entryId of stayIds) {
    await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.level as any }, {
      eventType,
      entityType: "Inquiry",
      entityId: inquiryId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId,
      entryId,
      payload: payload as any,
    });
  }
}

export async function linkInquiryEmail(
  prisma: PrismaClient,
  inquiryId: string,
  messageId: string,
  actor: Actor,
): Promise<EmailThreadSummary> {
  const { inq, live } = await loadInquiry(prisma, inquiryId);
  const email = await readInboxEmailInFull(messageId);
  if (!email) {
    throw new ValidationError("That email is not in the hotel's mailbox any more — pick another one");
  }
  const now = new Date();
  const updated = await prisma.inquiry.update({
    where: { id: inquiryId },
    data: {
      emailThreadMessageId: email.messageId,
      emailThreadSubject: email.subject,
      emailThreadFrom: email.fromAddress,
      emailThreadFromName: email.fromName,
      emailThreadReferences: email.references,
      emailThreadReceivedAt: email.receivedAt ? new Date(email.receivedAt) : null,
      emailThreadLinkedAt: now,
      emailThreadLinkedBy: actor.actorId,
      // A new conversation: none of ours is in it yet.
      emailThreadLastSentId: inq.emailThreadMessageId === email.messageId ? undefined : null,
    },
  });
  forgetInboxList();
  await recordFirstEmail(prisma, inquiryId, email, actor.actorId);
  await traceOnStays(prisma, actor, inquiryId, live.map((e) => e.id), "INQUIRY.EMAIL_LINKED", {
    messageId: email.messageId,
    subject: email.subject,
    from: email.fromAddress,
    fromName: email.fromName,
    receivedAt: email.receivedAt,
    replaced: inq.emailThreadMessageId && inq.emailThreadMessageId !== email.messageId
      ? { messageId: inq.emailThreadMessageId, subject: inq.emailThreadSubject }
      : null,
  });
  return describeEmailThread(updated)!;
}

export async function clearInquiryEmail(prisma: PrismaClient, inquiryId: string, actor: Actor): Promise<void> {
  const { inq, live } = await loadInquiry(prisma, inquiryId);
  if (!inq.emailThreadMessageId) throw new ValidationError("No email is linked to this enquiry");
  await prisma.inquiry.update({
    where: { id: inquiryId },
    data: {
      emailThreadMessageId: null,
      emailThreadSubject: null,
      emailThreadFrom: null,
      emailThreadFromName: null,
      emailThreadReferences: null,
      emailThreadReceivedAt: null,
      emailThreadLinkedAt: null,
      emailThreadLinkedBy: null,
      emailThreadLastSentId: null,
    },
  });
  await removeFirstEmail(prisma, inquiryId);
  await traceOnStays(prisma, actor, inquiryId, live.map((e) => e.id), "INQUIRY.EMAIL_UNLINKED", {
    messageId: inq.emailThreadMessageId,
    subject: inq.emailThreadSubject,
    from: inq.emailThreadFrom,
  });
}

/** Which enquiries already reply in these emails — the picker names them. */
export async function enquiriesLinkedTo(
  prisma: PrismaClient,
  messageIds: string[],
): Promise<Map<string, Array<{ inquiryId: string; referenceNumber: string }>>> {
  const out = new Map<string, Array<{ inquiryId: string; referenceNumber: string }>>();
  if (!messageIds.length) return out;
  const rows = await prisma.inquiry.findMany({
    where: { emailThreadMessageId: { in: messageIds } },
    select: { id: true, referenceNumber: true, emailThreadMessageId: true },
  });
  for (const r of rows) {
    const list = out.get(r.emailThreadMessageId!) ?? [];
    list.push({ inquiryId: r.id, referenceNumber: r.referenceNumber });
    out.set(r.emailThreadMessageId!, list);
  }
  return out;
}
