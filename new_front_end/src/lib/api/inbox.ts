import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/** One email in the hotel's mailbox, as the desk lists it (2026-11-12). */
export type InboxEmail = {
  messageId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  snippet: string;
  bulk: boolean;
  /** Enquiries that already reply in this email. */
  linkedTo: Array<{ inquiryId: string; referenceNumber: string }>;
};

/** The conversation an enquiry's papers reply in. */
export type EmailThread = {
  messageId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  linkedAt?: string | null;
  linkedBy?: string | null;
};

export function listInboxEmails(session: Session, opts: { q?: string; days?: number; all?: boolean; fresh?: boolean } = {}) {
  const p = new URLSearchParams();
  if (opts.q?.trim()) p.set("q", opts.q.trim());
  if (opts.days) p.set("days", String(opts.days));
  if (opts.all) p.set("all", "1");
  if (opts.fresh) p.set("fresh", "1");
  return apiRequest<{ mailbox: string | null; emails: InboxEmail[] }>(`/api/inbox/emails?${p.toString()}`, { session });
}

/** One email in full: who it went to, its words, its attachments' names (2026-11-12). */
export type InboxEmailRead = InboxEmail & {
  to: string[];
  cc: string[];
  text: string;
  /** What the person wrote, and the earlier email they quoted, apart. */
  fresh: string;
  quoteHeader: string | null;
  quoted: string;
  cut: boolean;
  attachments: Array<{ name: string; type: string; size: number | null }>;
};

export function readInboxEmail(session: Session, messageId: string) {
  return apiRequest<{ email: InboxEmailRead }>(`/api/inbox/email?id=${encodeURIComponent(messageId)}`, { session });
}

export function linkInquiryEmail(session: Session, inquiryId: string, messageId: string) {
  return apiRequest<{ emailThread: EmailThread }>(`/api/inquiries/${encodeURIComponent(inquiryId)}/email-thread`, {
    method: "POST",
    session,
    body: { messageId },
  });
}

export function clearInquiryEmail(session: Session, inquiryId: string) {
  return apiRequest<{ emailThread: null }>(`/api/inquiries/${encodeURIComponent(inquiryId)}/email-thread/clear`, {
    method: "POST",
    session,
    body: {},
  });
}

/**
 * A subject as a person reads it: the test redirect's "[→someone]" mark left out, and "Re: Re:"
 * written once.
 */
export function cleanSubject(subject: string | null | undefined): string {
  const s = (subject ?? "")
    .replace(/\[→[^\]]*\]\s*/g, "")
    .replace(/^(\s*(re|aw|sv)\s*:\s*)+/i, "Re: ")
    .trim();
  return s || "(no subject)";
}

/** The enquiry's linked email off the booking payload, or null. */
export function emailThreadOf(inq: {
  emailThreadMessageId?: string | null;
  emailThreadSubject?: string | null;
  emailThreadFrom?: string | null;
  emailThreadFromName?: string | null;
  emailThreadReceivedAt?: string | null;
} | null | undefined): EmailThread | null {
  if (!inq?.emailThreadMessageId) return null;
  return {
    messageId: inq.emailThreadMessageId,
    subject: inq.emailThreadSubject ?? "(no subject)",
    fromName: inq.emailThreadFromName ?? null,
    fromAddress: inq.emailThreadFrom ?? null,
    receivedAt: inq.emailThreadReceivedAt ?? null,
  };
}

/* ---------- a booking's conversation (2026-11-12) ---------- */

/** One email of an enquiry's conversation: their first email, what we sent, their replies. */
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
  inReplyTo: string | null;
  seen: boolean;
  answered: { communicationId: string; at: string | null; by: string | null } | null;
};

export type Conversation = { inquiryId: string; mailbox: string | null; emails: ConversationEmail[]; unseen: number };

export function getConversation(session: Session, entryId: string) {
  return apiRequest<Conversation>(`/api/inbox/conversations/${encodeURIComponent(entryId)}`, { session });
}

/** Look in the mailbox for replies now. */
export function checkConversation(session: Session, entryId: string) {
  return apiRequest<Conversation & { found: number }>(`/api/inbox/conversations/${encodeURIComponent(entryId)}/check`, {
    method: "POST",
    session,
    body: {},
  });
}

export function markConversationSeen(session: Session, entryId: string) {
  return apiRequest<{ marked: number }>(`/api/inbox/conversations/${encodeURIComponent(entryId)}/seen`, {
    method: "POST",
    session,
    body: {},
  });
}

export type UnseenReply = {
  id: string;
  inquiryId: string;
  referenceNumber: string;
  entryId: string | null;
  guest: string | null;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  snippet: string;
  at: string;
  answersKind: string | null;
};

export function listUnseenReplies(session: Session) {
  return apiRequest<{ items: UnseenReply[] }>(`/api/inbox/replies/unseen`, { session });
}

/** A reply recorded as the guest's answer to one of the booking's papers. */
export function recordReplyAsAnswer(session: Session, replyId: string, communicationId: string) {
  return apiRequest<{ recorded: boolean; words: string }>(`/api/inbox/replies/${encodeURIComponent(replyId)}/answer`, {
    method: "POST",
    session,
    body: { communicationId },
  });
}

/** What a paper is called on the desk. */
export const PAPER_WORDS: Record<string, string> = {
  QUOTATION: "Quotation",
  PROFORMA_INVOICE: "Proforma invoice",
  CONFIRMATION_VOUCHER: "Confirmation voucher",
  PRE_ARRIVAL_REMINDER: "Pre-arrival message",
  INTERIM_INVOICE: "Mid-stay bill",
  FINAL_INVOICE: "Tax invoice",
  BILL: "Bill",
  FEEDBACK: "Feedback request",
  NO_SHOW: "No-show notice",
  OTHER: "Email",
};
