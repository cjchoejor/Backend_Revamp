/**
 * Email service — single entry point for all outbound SMTP. Used by stage services across S1..S9
 * to send guest communications (quotation, proforma invoice, confirmation, pre-arrival,
 * final invoice, feedback).
 *
 * Transport: Nodemailer over Gmail SMTP. App Password auth (per .env). Easy swap to a transactional
 * service later by replacing this file's transporter without touching callers.
 *
 * Threading: each guest journey (one Entry row) gets a single Gmail thread. The first email sent
 * for an Entry assigns a stable Message-ID and persists it on Entry.emailThreadRootMessageId.
 * Every later email for the same Entry references that ID via In-Reply-To / References headers
 * AND keeps a consistent subject prefix — Gmail clusters them as one conversation.
 *
 * Testing redirect: when EMAIL_REDIRECT_ALL_TO is set, every send is rerouted to that address
 * with `[→original@email]` prepended to the subject. Lets you fully test without spamming guests.
 */

import nodemailer, { type Transporter } from "nodemailer";
import type { PrismaClient } from "@prisma/client";

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT ?? 465);
  const secure = (process.env.SMTP_SECURE ?? "true").toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  if (!host || !user || !pass) {
    throw new Error(
      "Email transport is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env (see .env.example).",
    );
  }

  // One kept-open connection reused between sends (2026-11-10): a fresh connection and sign-in
  // cost about 1.2 s before every email. The pool reconnects by itself when the server drops it.
  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
  });
  return cachedTransporter;
}

type SendArgs = {
  /** Real recipient email (the guest). May be overridden by EMAIL_REDIRECT_ALL_TO at send time. */
  to: string;
  /** Human-readable subject. The service prepends `[ENT-XXXX]` automatically when threadEntryId is given. */
  subject: string;
  /** Optional HTML body. Either html or text (or both) must be provided. */
  html?: string;
  /** Optional plain-text body. Recommended alongside html for deliverability. */
  text?: string;
  /**
   * If set, this email is threaded under the Entry's journey. The first send establishes a
   * Message-ID and persists it on Entry; later sends reference it so Gmail clusters them.
   */
  threadEntryId?: string;
  /**
   * Readable ID for the Entry (e.g. "ENT-0042"). When given, the service prepends `[ENT-0042]`
   * to the subject so Gmail's subject-based threading agrees with the header-based threading.
   * Required for stable threading; the route's caller is responsible for resolving it.
   */
  threadReadableId?: string;
  /**
   * PDF attachments. Each entry is a filename + bytes buffer + contentType. Used to attach
   * quotation / proforma / confirmation-voucher / final invoice PDFs to their stage emails.
   * Attachments carry the actual guest-facing artifact so recipients can archive it locally.
   */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** Which paper it carries (QUOTATION, PROFORMA_INVOICE, …), for the enquiry's conversation. */
  paperKind?: string | null;
};

type SendResult =
  | {
      status: "sent";
      messageId: string;
      redirected: boolean;
      intendedRecipient: string;
      actualRecipient: string;
      /** It went as a reply inside the guest's own email (the enquiry's linked conversation). */
      repliedInGuestEmail?: boolean;
    }
  | { status: "skipped"; reason: "EMAIL_DISABLE" }
  | { status: "error"; message: string };

const FOOTER_TEXT = "—\nLegphel Hotel · Thimphu, Bhutan\nThis is an automated message from the hotel's property management system. Reply to this email to reach the front desk directly.";
const FOOTER_HTML = `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px"/>
<p style="color:#666;font-size:12px;line-height:1.5;margin:0">
  <strong>Legphel Hotel</strong> · Thimphu, Bhutan<br/>
  This is an automated message from the hotel's property management system. Reply to this email
  to reach the front desk directly.
</p>`;

/** "Re: <their subject>", as a person replying would write it — never "Re: Re:". */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim() || "(no subject)";
  return /^(re|aw|sv|antw)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** The References of a reply: the conversation before, their email, then ours, each once. */
function referencesFor(prior: string | null, theirs: string, ours: string | null): string {
  const ids = [...(prior?.match(/<[^<>\s]+>/g) ?? []), theirs, ...(ours ? [ours] : [])];
  return [...new Set(ids)].slice(-20).join(" ");
}

function applySubjectPrefix(subject: string, threadReadableId: string | undefined): string {
  if (!threadReadableId) return subject;
  // If already prefixed, don't double-prefix (idempotent for retries).
  if (subject.startsWith(`[${threadReadableId}]`)) return subject;
  return `[${threadReadableId}] ${subject}`;
}

function applyRedirectPrefix(subject: string, intendedRecipient: string): string {
  return `[→${intendedRecipient}] ${subject}`;
}

function appendFooter(text: string | undefined, html: string | undefined): { text?: string; html?: string } {
  return {
    text: text != null ? `${text}\n\n${FOOTER_TEXT}` : undefined,
    html: html != null ? `${html}${FOOTER_HTML}` : undefined,
  };
}

/**
 * Send an email. The function handles: thread anchoring, subject prefix, test redirect, plain-text
 * fallback derivation, footer attachment, and (when threadEntryId is provided) persisting the
 * root Message-ID on the Entry row inside a transaction.
 */
export async function sendEmail(prisma: PrismaClient, args: SendArgs): Promise<SendResult> {
  if ((process.env.EMAIL_DISABLE ?? "").toLowerCase() === "true") {
    return { status: "skipped", reason: "EMAIL_DISABLE" };
  }

  if (!args.html && !args.text) {
    return { status: "error", message: "Either html or text body must be provided" };
  }

  // 1. Resolve thread anchoring.
  //
  // Gmail SMTP relay rewrites custom Message-IDs on outbound delivery, so any value we hand
  // Nodemailer (`messageId`) gets replaced before it lands in the inbox. If we then send a
  // follow-up with `In-Reply-To: <our-original-id>`, Gmail can't find the referenced message
  // and starts a new thread.
  //
  // Workaround: let Nodemailer/Gmail mint the Message-ID. After send, `info.messageId` is the
  // header value as actually written into the email — that's the one we persist on the Entry
  // and reference from later emails.
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let isFirstInThread = false;
  // The guest's own email, when the desk linked one to the enquiry (2026-11-12): every paper goes
  // out as a reply inside it — "Re: <their subject>", In-Reply-To their email, References the whole
  // conversation — so the guest and the hotel's mailbox both see one conversation.
  let guestThread: { inquiryId: string; subject: string } | null = null;

  if (args.threadEntryId) {
    const entry = await prisma.entry.findUnique({
      where: { id: args.threadEntryId },
      select: {
        emailThreadRootMessageId: true,
        inquiry: {
          select: {
            id: true,
            emailThreadMessageId: true,
            emailThreadSubject: true,
            emailThreadReferences: true,
            emailThreadLastSentId: true,
          },
        },
      },
    });
    const linked = entry?.inquiry?.emailThreadMessageId ? entry.inquiry : null;
    if (linked) {
      inReplyTo = linked.emailThreadMessageId!;
      references = referencesFor(linked.emailThreadReferences, linked.emailThreadMessageId!, linked.emailThreadLastSentId);
      guestThread = { inquiryId: linked.id, subject: replySubject(linked.emailThreadSubject) };
      if (!entry?.emailThreadRootMessageId) isFirstInThread = true;
    } else if (entry?.emailThreadRootMessageId) {
      // Subsequent email in an established thread.
      inReplyTo = entry.emailThreadRootMessageId;
      references = entry.emailThreadRootMessageId;
    } else {
      isFirstInThread = true;
    }
  }

  // 2. Build subject (thread prefix + optional redirect prefix).
  const intendedRecipient = args.to;
  const redirectTo = process.env.EMAIL_REDIRECT_ALL_TO?.trim();
  const actualRecipient = redirectTo || intendedRecipient;
  // A reply keeps the guest's subject exactly: a changed subject splits the conversation.
  let subject = guestThread ? guestThread.subject : applySubjectPrefix(args.subject, args.threadReadableId);
  if (redirectTo) subject = applyRedirectPrefix(subject, intendedRecipient);

  // 3. Append footer to body.
  const body = appendFooter(args.text, args.html);

  // 4. Send.
  const transporter = getTransporter();
  const from = process.env.EMAIL_FROM?.trim() ?? process.env.SMTP_USER?.trim();
  const replyTo = process.env.EMAIL_REPLY_TO?.trim() || undefined;

  // Headers that improve deliverability scoring without changing visible content:
  //  - List-Unsubscribe + List-Unsubscribe-Post: RFC 8058 one-click unsubscribe. Many spam
  //    filters significantly de-weight messages that lack this on transactional/bulk mail.
  //  - Auto-Submitted: auto-generated marks the message as machine-originated transactional
  //    mail (RFC 3834), which is what it is — guests should NOT auto-reply to confirmations.
  //  - X-Auto-Response-Suppress: avoids out-of-office bounces back to the sender.
  const unsubscribeMailto = replyTo || from || actualRecipient;
  const extraHeaders: Record<string, string> = {
    "List-Unsubscribe": `<mailto:${unsubscribeMailto}?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "OOF, AutoReply",
  };

  let info: { messageId: string };
  const mail = () =>
    transporter.sendMail({
      from,
      to: actualRecipient,
      replyTo,
      subject,
      text: body.text,
      html: body.html,
      // Intentionally NOT setting `messageId` — see note above. Nodemailer generates one and
      // Gmail's relay accepts it as-is.
      inReplyTo,
      references,
      headers: extraHeaders,
      // PDFs the guest should receive alongside the email body (quotation, proforma,
      // confirmation voucher, final invoice). Buffer form — no disk read at send time.
      attachments: args.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType ?? "application/pdf",
      })),
    });
  try {
    try {
      info = await mail();
    } catch (e) {
      // A kept-open connection the mail server has closed fails once; send again on a new one.
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string } | null)?.code ?? "";
      if (!/ECONNECTION|ESOCKET|ETIMEDOUT|ECONNRESET|EPIPE/.test(code) && !/closed|reset|timeout/i.test(msg)) throw e;
      info = await mail();
    }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }

  // 5. Persist root Message-ID if this was the first email in the thread. Use the actual
  //    Message-ID returned by Nodemailer (`info.messageId`) — that's what's in the email's
  //    headers, and what later In-Reply-To references must point at to thread in Gmail.
  if (isFirstInThread && args.threadEntryId && info.messageId) {
    await prisma.entry.update({
      where: { id: args.threadEntryId },
      data: { emailThreadRootMessageId: info.messageId },
    });
  }
  // Every email for a stay is a line of its enquiry's conversation (2026-11-12), so a reply to it
  // can be found and filed. Never fails the send.
  if (args.threadEntryId && info.messageId) {
    const firstLines = (args.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
    const { recordSentEmail } = await import("../domain/guest-email-conversation-service.js");
    await recordSentEmail(prisma, {
      entryId: args.threadEntryId,
      messageId: info.messageId,
      to: intendedRecipient,
      subject,
      paperKind: args.paperKind ?? null,
      attachmentNames: (args.attachments ?? []).map((a) => a.filename),
      inReplyTo: inReplyTo ?? null,
      snippet: firstLines.slice(0, 240),
    });
  }
  // Ours is now the latest in the guest's conversation; the next reply names it too. Not when the
  // test redirect sent it elsewhere: the guest never had it.
  if (guestThread && info.messageId && !redirectTo) {
    await prisma.inquiry.update({
      where: { id: guestThread.inquiryId },
      data: { emailThreadLastSentId: info.messageId },
    });
  }

  return {
    status: "sent",
    messageId: info.messageId,
    redirected: !!redirectTo,
    intendedRecipient,
    actualRecipient,
    repliedInGuestEmail: !!guestThread,
  };
}

/**
 * Smoke test for env configuration — does NOT actually send. Returns whether the transporter
 * can authenticate against SMTP. Use this from a health route or one-shot CLI.
 */
export async function verifyTransport(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const t = getTransporter();
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
