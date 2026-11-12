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
