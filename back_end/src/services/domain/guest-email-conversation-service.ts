/**
 * AN ENQUIRY'S EMAIL CONVERSATION (2026-11-12, operator: the guest's replies on the booking — "do it").
 *
 * Three kinds of email, kept as `InquiryEmail` rows on the enquiry (so a trip's stays share them):
 *   - FIRST — the guest's or the agency's own email the desk linked (inquiry-email-thread-service);
 *   - SENT  — every email the system sent for a stay of the enquiry, linked or not (`sendEmail`);
 *   - REPLY — an email in the hotel's mailbox that answers one of those: its In-Reply-To / References
 *             name a FIRST or SENT email, the enquiry's linked email, or a booking's own first email.
 *
 * The mailbox is looked at every couple of minutes by the workers (`pollInboxForReplies`) and when the
 * desk asks. Only who, when, the subject and the first lines are kept; the words stay in the mailbox
 * and are read from there. A reply can be recorded as the guest's answer to a paper (the paper's
 * CommunicationRecord), with their words, through the one answer-recording service.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import * as auditService from "../infrastructure/audit-service.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import {
  inboxAddress,
  newPartOf,
  readInboxEmailInFull,
  rescanInboxFromWindow,
  scanInboxForNew,
  type InboxEmail,
} from "../infrastructure/mail-inbox-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { actorId: string; level: string };

const ENDED = new Set(["CANCELLED", "EXPIRED", "CLOSED"]);

/* ---------- what we send ---------- */

/** Which paper an email carried, from the stage email's name (`QUOTATION_EMAIL` → QUOTATION). */
export function paperKindOfEmail(eventTypePrefix: string | null | undefined): string | null {
  const p = (eventTypePrefix ?? "").toUpperCase();
  if (!p) return null;
  if (p.startsWith("TRIP_PAPER_QUOTATION") || p === "QUOTATION_EMAIL") return "QUOTATION";
  if (p.startsWith("TRIP_PAPER_PROFORMA") || p === "PROFORMA_INVOICE_EMAIL") return "PROFORMA_INVOICE";
  if (p.startsWith("TRIP_PAPER_VOUCHER") || p.startsWith("RESERVATION_CONFIRMATION")) return "CONFIRMATION_VOUCHER";
  if (p.startsWith("PRE_ARRIVAL")) return "PRE_ARRIVAL_REMINDER";
  if (p.startsWith("INTERIM")) return "INTERIM_INVOICE";
  if (p.startsWith("FINAL_INVOICE")) return "FINAL_INVOICE";
  if (p.startsWith("FEEDBACK")) return "FEEDBACK";
  if (p.startsWith("NO_SHOW")) return "NO_SHOW";
  return "OTHER";
}

/** An email the system sent for a stay: one row of the enquiry's conversation. Never throws. */
export async function recordSentEmail(
  prisma: PrismaClient,
  input: {
    entryId: string;
    messageId: string;
    to: string;
    subject: string;
    paperKind?: string | null;
    attachmentNames?: string[];
    inReplyTo?: string | null;
    snippet?: string;
  },
): Promise<void> {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, select: { inquiryId: true } });
    if (!entry || !input.messageId) return;
    const data = {
      entryId: input.entryId,
      kind: "SENT",
      fromAddress: inboxAddress(),
      fromName: null,
      toAddresses: [input.to],
      subject: input.subject,
      snippet: (input.snippet ?? "").slice(0, 240),
      at: new Date(),
      paperKind: input.paperKind ?? null,
      attachmentNames: input.attachmentNames ?? [],
      inReplyTo: input.inReplyTo ?? null,
    };
    await prisma.inquiryEmail.upsert({
      where: { inquiryId_messageId: { inquiryId: entry.inquiryId, messageId: input.messageId } },
      create: { inquiryId: entry.inquiryId, messageId: input.messageId, ...data },
      update: data,
    });
  } catch (e) {
    console.error("[conversation] could not record a sent email:", e instanceof Error ? e.message : e);
  }
}

/** The guest's own email, linked: the first of the conversation, seen by whoever linked it. */
export async function recordFirstEmail(
  db: Db,
  inquiryId: string,
  email: InboxEmail,
  actorId: string,
): Promise<void> {
  // One first email: picking another replaces it.
  await db.inquiryEmail.deleteMany({ where: { inquiryId, kind: "FIRST", messageId: { not: email.messageId } } });
  const data = {
    kind: "FIRST",
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    subject: email.subject,
    snippet: email.snippet ?? "",
    at: email.receivedAt ? new Date(email.receivedAt) : new Date(),
    seenAt: new Date(),
    seenBy: actorId,
  };
  await db.inquiryEmail.upsert({
    where: { inquiryId_messageId: { inquiryId, messageId: email.messageId } },
    create: { inquiryId, messageId: email.messageId, ...data },
    update: data,
  });
}

export async function removeFirstEmail(db: Db, inquiryId: string): Promise<void> {
  await db.inquiryEmail.deleteMany({ where: { inquiryId, kind: "FIRST" } });
}

/* ---------- watching for replies ---------- */

type Owner = { inquiryId: string; entryId: string | null; answersKind: string | null };

/**
 * Which enquiries each of these message ids belongs to, and what it carried. One email can be the
 * conversation of more than one enquiry (an agency writing about two bookings in one email).
 */
async function ownersOf(prisma: PrismaClient, ids: string[]): Promise<Map<string, Owner[]>> {
  const out = new Map<string, Owner[]>();
  if (!ids.length) return out;
  const add = (id: string, o: Owner) => {
    const list = out.get(id) ?? [];
    if (!list.some((x) => x.inquiryId === o.inquiryId)) list.push(o);
    out.set(id, list);
  };
  const rows = await prisma.inquiryEmail.findMany({
    where: { messageId: { in: ids }, kind: { in: ["FIRST", "SENT"] } },
    select: { inquiryId: true, entryId: true, messageId: true, paperKind: true },
  });
  for (const r of rows) add(r.messageId, { inquiryId: r.inquiryId, entryId: r.entryId, answersKind: r.paperKind });
  const linked = await prisma.inquiry.findMany({
    where: { OR: [{ emailThreadMessageId: { in: ids } }, { emailThreadLastSentId: { in: ids } }] },
    select: { id: true, emailThreadMessageId: true, emailThreadLastSentId: true },
  });
  for (const q of linked) {
    for (const id of [q.emailThreadMessageId, q.emailThreadLastSentId]) {
      if (id && ids.includes(id)) add(id, { inquiryId: q.id, entryId: null, answersKind: null });
    }
  }
  // A booking's own conversation from before this (the system's first email to it).
  const roots = await prisma.entry.findMany({
    where: { emailThreadRootMessageId: { in: ids } },
    select: { id: true, inquiryId: true, emailThreadRootMessageId: true },
  });
  for (const e of roots) {
    add(e.emailThreadRootMessageId!, { inquiryId: e.inquiryId, entryId: e.id, answersKind: null });
  }
  return out;
}

/**
 * The enquiries a scanned email belongs to: those of the email it replies to, else those of the
 * latest email of its conversation we know. Usually one; every one when an email is shared.
 */
function ownersOfEmail(answers: string[], inReplyTo: string | null, owners: Map<string, Owner[]>): Owner[] {
  if (inReplyTo && owners.has(inReplyTo)) return owners.get(inReplyTo)!;
  for (const id of [...answers].reverse()) if (owners.has(id)) return owners.get(id)!;
  return [];
}

export type PollOutcome = { looked: number; found: number; inquiries: string[] };

let polling: Promise<PollOutcome> | null = null;

/**
 * Look in the mailbox for replies to our emails and file them on their enquiries. One look at a
 * time; a look asked for while one runs waits for it. Never throws: a mailbox that cannot be read
 * is said in the log and tried again next time.
 */
export async function pollInboxForReplies(
  prisma: PrismaClient,
  opts: { fromWindow?: boolean; lookbackDays?: number } = {},
): Promise<PollOutcome> {
  if (polling) return polling;
  polling = (async () => {
    try {
      if (opts.fromWindow) rescanInboxFromWindow();
      const me = (inboxAddress() ?? "").toLowerCase();
      let owners = new Map<string, Owner[]>();
      const scanned = await scanInboxForNew({
        lookbackDays: opts.lookbackDays ?? 3,
        pick: async (emails) => {
          owners = await ownersOf(prisma, [...new Set(emails.flatMap((e) => e.answers))]);
          const ours = new Set(
            (
              await prisma.inquiryEmail.findMany({
                where: { messageId: { in: emails.map((e) => e.messageId) }, kind: "SENT" },
                select: { messageId: true },
              })
            ).map((r) => r.messageId),
          );
          // An email we sent ourselves is not a reply, wherever it landed.
          return new Set(
            emails.filter((e) => !ours.has(e.messageId) && ownersOfEmail(e.answers, e.inReplyTo, owners).length).map((e) => e.messageId),
          );
        },
      });
      const touched = new Set<string>();
      let found = 0;
      for (const e of scanned) {
        for (const owner of ownersOfEmail(e.answers, e.inReplyTo, owners)) {
          if (await fileReply(prisma, e, owner, me)) {
            found += 1;
            touched.add(owner.inquiryId);
          }
        }
      }
      return { looked: scanned.length, found, inquiries: [...touched] };
    } catch (e) {
      console.error("[conversation] could not look for replies:", e instanceof Error ? e.message : e);
      return { looked: 0, found: 0, inquiries: [] };
    } finally {
      polling = null;
    }
  })();
  return polling;
}

/** One reply on one enquiry's conversation, once; traced on the stay. True when it was new. */
async function fileReply(
  prisma: PrismaClient,
  e: { messageId: string; fromAddress: string | null; fromName: string | null; subject: string; snippet: string; receivedAt: string | null; inReplyTo: string | null },
  owner: Owner,
  me: string,
): Promise<boolean> {
  const exists = await prisma.inquiryEmail.findUnique({
    where: { inquiryId_messageId: { inquiryId: owner.inquiryId, messageId: e.messageId } },
    select: { id: true },
  });
  if (exists) return false;
  const stay = owner.entryId ?? (await firstLiveStay(prisma, owner.inquiryId));
  await prisma.inquiryEmail.create({
    data: {
      inquiryId: owner.inquiryId,
      entryId: stay,
      kind: "REPLY",
      messageId: e.messageId,
      fromAddress: e.fromAddress,
      fromName: e.fromName,
      subject: e.subject,
      snippet: e.snippet,
      at: e.receivedAt ? new Date(e.receivedAt) : new Date(),
      inReplyTo: e.inReplyTo,
      answersKind: owner.answersKind,
    },
  });
  if (stay) {
    await auditService.emit(prisma as any, auditService.systemActor(), {
      eventType: "INQUIRY.GUEST_REPLIED",
      entityType: "Inquiry",
      entityId: owner.inquiryId,
      operation: "CREATE",
      timestamp: new Date(),
      inquiryId: owner.inquiryId,
      entryId: stay,
      payload: {
        messageId: e.messageId,
        from: e.fromAddress,
        fromName: e.fromName,
        subject: e.subject,
        answersKind: owner.answersKind,
        fromHotelAddress: !!me && e.fromAddress === me,
      } as any,
    });
  }
  return true;
}

async function firstLiveStay(prisma: PrismaClient, inquiryId: string): Promise<string | null> {
  const stays = await prisma.entry.findMany({
    where: { inquiryId },
    select: { id: true, status: true },
    orderBy: { checkInDate: "asc" },
  });
  return (stays.find((s) => !ENDED.has(s.status)) ?? stays[0])?.id ?? null;
}

/* ---------- the desk's reads ---------- */

export type ConversationEmail = {
  id: string;
  kind: "FIRST" | "SENT" | "REPLY";
  messageId: string;
  entryId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  to: string[];
  subject: string;
  snippet: string;
  at: string;
  paperKind: string | null;
  attachmentNames: string[];
  answersKind: string | null;
  seen: boolean;
  answered: { communicationId: string; at: string | null; by: string | null } | null;
};

function shape(r: Prisma.InquiryEmailGetPayload<object>): ConversationEmail {
  return {
    id: r.id,
    kind: r.kind as ConversationEmail["kind"],
    messageId: r.messageId,
    entryId: r.entryId,
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    to: r.toAddresses,
    subject: r.subject,
    snippet: r.snippet,
    at: r.at.toISOString(),
    paperKind: r.paperKind,
    attachmentNames: r.attachmentNames,
    answersKind: r.answersKind,
    seen: r.kind !== "REPLY" || !!r.seenAt,
    answered: r.answeredCommunicationId
      ? { communicationId: r.answeredCommunicationId, at: r.answeredAt?.toISOString() ?? null, by: r.answeredBy }
      : null,
  };
}

async function inquiryOfEntry(prisma: PrismaClient, entryId: string): Promise<string> {
  const e = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  if (!e) throw new NotFoundError("Entry");
  return e.inquiryId;
}

/** A booking's conversation (its enquiry's), oldest first, with how many replies are new. */
export async function listConversation(prisma: PrismaClient, entryId: string) {
  const inquiryId = await inquiryOfEntry(prisma, entryId);
  const rows = await prisma.inquiryEmail.findMany({ where: { inquiryId }, orderBy: { at: "asc" } });
  const emails = rows.map(shape);
  return {
    inquiryId,
    mailbox: inboxAddress(),
    emails,
    unseen: emails.filter((e) => !e.seen).length,
  };
}

export async function markConversationSeen(prisma: PrismaClient, entryId: string, actorId: string) {
  const inquiryId = await inquiryOfEntry(prisma, entryId);
  const r = await prisma.inquiryEmail.updateMany({
    where: { inquiryId, kind: "REPLY", seenAt: null },
    data: { seenAt: new Date(), seenBy: actorId },
  });
  return { marked: r.count };
}

/** Replies nobody has looked at yet, newest first — for the bell. */
export async function listUnseenReplies(prisma: PrismaClient) {
  const rows = await prisma.inquiryEmail.findMany({
    where: { kind: "REPLY", seenAt: null },
    orderBy: { at: "desc" },
    take: 50,
    include: {
      inquiry: {
        select: {
          referenceNumber: true,
          entries: {
            select: { id: true, status: true, currentStage: true, checkInDate: true, guestProfile: { select: { title: true, firstName: true, lastName: true } } },
            orderBy: { checkInDate: "asc" },
          },
        },
      },
    },
  });
  return rows.map((r) => {
    const stays = r.inquiry.entries;
    const stay = stays.find((s) => s.id === r.entryId) ?? stays.find((s) => !ENDED.has(s.status)) ?? stays[0] ?? null;
    return {
      id: r.id,
      inquiryId: r.inquiryId,
      referenceNumber: r.inquiry.referenceNumber,
      entryId: stay?.id ?? null,
      guest: stay ? guestDisplayName(stay.guestProfile) || null : null,
      fromName: r.fromName,
      fromAddress: r.fromAddress,
      subject: r.subject,
      snippet: r.snippet,
      at: r.at.toISOString(),
      answersKind: r.answersKind,
    };
  });
}

/* ---------- a reply as the guest's answer ---------- */

/**
 * Record a reply as the guest's answer to one of the enquiry's papers: the paper's own answer is
 * recorded (WRITTEN, with the words they wrote above the quoted mail, at the time they wrote), and
 * the reply says which paper it answered.
 */
export async function recordReplyAsAnswer(
  prisma: PrismaClient,
  replyId: string,
  communicationId: string,
  actor: Actor,
) {
  const reply = await prisma.inquiryEmail.findUnique({ where: { id: replyId } });
  if (!reply || reply.kind !== "REPLY") throw new NotFoundError("Reply");
  if (reply.answeredCommunicationId) {
    throw new ValidationError("This reply is already recorded as their answer");
  }
  const comm = await prisma.communicationRecord.findUnique({
    where: { id: communicationId },
    select: { id: true, entryId: true, entry: { select: { inquiryId: true } } },
  });
  if (!comm || comm.entry?.inquiryId !== reply.inquiryId) {
    throw new ValidationError("That paper is not one of this enquiry's");
  }
  const full = await readInboxEmailInFull(reply.messageId);
  const words = newPartOf(full?.text ?? reply.snippet).slice(0, 2000) || reply.snippet || "(their email)";
  const verbatimNote = `By email, ${reply.fromName ?? reply.fromAddress ?? "the guest"}: ${words}`;
  // A quotation's answer is the guest accepting it — the same act as the quotation's own Record the
  // answer, so the quotation reads accepted (and its answer is recorded with it).
  const quotation = await prisma.quotation.findFirst({
    where: { communicationRecordId: communicationId },
    select: { id: true, state: true },
  });
  if (quotation) {
    if (quotation.state !== "SENT") {
      throw new ValidationError(
        quotation.state === "ACCEPTED" ? "The quotation is already accepted" : "That quotation is no longer waiting for an answer",
      );
    }
    const { acceptQuotation } = await import("./s2-quotation-service.js");
    await acceptQuotation(prisma, quotation.id, actor.actorId, { acceptanceMethod: "WRITTEN", verbatimNote });
    const now = new Date();
    await prisma.inquiryEmail.update({
      where: { id: replyId },
      data: { answeredCommunicationId: communicationId, answeredAt: now, answeredBy: actor.actorId, seenAt: reply.seenAt ?? now, seenBy: reply.seenBy ?? actor.actorId },
    });
    return { recorded: true, words, accepted: quotation.id };
  }
  await recordCommunicationAcknowledgement(
    prisma,
    communicationId,
    { actorId: actor.actorId, actorLevel: actor.level as "L1" | "L2" | "L3" | "L4" },
    { method: "WRITTEN", verbatimNote, receivedAt: reply.at.toISOString() },
  );
  const now = new Date();
  await prisma.inquiryEmail.update({
    where: { id: replyId },
    data: { answeredCommunicationId: communicationId, answeredAt: now, answeredBy: actor.actorId, seenAt: reply.seenAt ?? now, seenBy: reply.seenBy ?? actor.actorId },
  });
  return { recorded: true, words };
}
