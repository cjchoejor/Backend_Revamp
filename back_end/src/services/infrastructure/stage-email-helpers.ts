/**
 * Shared best-effort email-send helper used by every stage service (S2..S9). Encapsulates the
 * pattern that s4-confirmation-service introduced in Phase 2: skip silently when the guest has no
 * email, swallow SMTP errors, and write a per-stage TraceEvent for the audit trail.
 *
 * Threading is anchored on Entry.id (so every email for the same guest journey lands in one Gmail
 * conversation). The subject prefix uses the inquiry's readable ID so the prefix stays stable from
 * S2 (no reservation yet) through S9.
 */

import type { PrismaClient, Stage } from "@prisma/client";
import { sendEmail } from "./email-service.js";

export type StageEmailContent = {
  subject: string;
  text: string;
  html: string;
  /** Optional PDF attachments — passed straight through to sendEmail. */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
};

export type StageEmailContext = {
  prisma: PrismaClient;
  entryId: string;
  actorId: string;
  inquiryId: string;
  /** The guest's email on file. When null we skip and trace why. */
  guestEmail: string | null;
  /**
   * Why there is no address, when the caller knows better than "the guest has none" — e.g. an
   * invoice addressed to an agency with no email on file (2026-09-18). Defaults to
   * GUEST_HAS_NO_EMAIL.
   */
  skipReason?: string | null;
  stage: Stage;
  /** Prefix for trace event types — e.g. "QUOTATION_EMAIL", "PROFORMA_INVOICE_EMAIL". */
  eventTypePrefix: string;
};

export async function dispatchStageEmailBestEffort(ctx: StageEmailContext, content: StageEmailContent): Promise<void> {
  const { prisma, entryId, actorId, inquiryId, guestEmail, stage, eventTypePrefix } = ctx;

  if (!guestEmail) {
    await writeStageEmailTrace({ prisma, entryId, actorId, inquiryId, stage }, `${eventTypePrefix}.SKIPPED`, {
      reason: ctx.skipReason ?? "GUEST_HAS_NO_EMAIL",
    });
    return;
  }

  try {
    const result = await sendEmail(prisma, {
      to: guestEmail,
      subject: content.subject,
      text: content.text,
      html: content.html,
      threadEntryId: entryId,
      threadReadableId: inquiryId,
      attachments: content.attachments,
    });
    if (result.status === "sent") {
      await writeStageEmailTrace({ prisma, entryId, actorId, inquiryId, stage }, `${eventTypePrefix}.SENT`, {
        messageId: result.messageId,
        intendedRecipient: result.intendedRecipient,
        actualRecipient: result.actualRecipient,
        redirected: result.redirected,
      });
    } else if (result.status === "skipped") {
      await writeStageEmailTrace({ prisma, entryId, actorId, inquiryId, stage }, `${eventTypePrefix}.SKIPPED`, {
        reason: result.reason,
      });
    } else {
      await writeStageEmailTrace({ prisma, entryId, actorId, inquiryId, stage }, `${eventTypePrefix}.ERROR`, {
        message: result.message,
      });
    }
  } catch (e) {
    await writeStageEmailTrace({ prisma, entryId, actorId, inquiryId, stage }, `${eventTypePrefix}.ERROR`, {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function writeStageEmailTrace(
  ctx: { prisma: PrismaClient; entryId: string; actorId: string; inquiryId: string; stage: Stage },
  eventType: string,
  payload: Record<string, unknown>,
) {
  await ctx.prisma.traceEvent.create({
    data: {
      eventType,
      actorId: ctx.actorId,
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: ctx.entryId,
      operation: "DISPATCH",
      timestamp: new Date(),
      stageContext: ctx.stage,
      inquiryId: ctx.inquiryId,
      entryId: ctx.entryId,
      payload: payload as any,
      createdBy: ctx.actorId,
    },
  });
}

// --- Small render utilities reused by every template ---

/**
 * A STAY date ("Wednesday, 30 Sep 2026") — stored at UTC midnight, so read on the UTC calendar.
 * It used the host's own timezone (2026-09-19): right on a server set to Bhutan time, a day early
 * on one west of UTC.
 */
export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A MOMENT — valid until, due by, held until — on the hotel's clock, with its time. */
export function formatMoment(d: Date | null | undefined): string {
  if (!d) return "—";
  const tz = process.env.HOTEL_TIMEZONE?.trim() || "Asia/Thimphu";
  const day = new Date(d).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric", timeZone: tz });
  const time = new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  return `${day}, ${time}`;
}

export function formatMoney(amount: number | null | undefined, currency: string): string {
  const safe = Number.isFinite(amount as number) ? (amount as number) : 0;
  return `${currency} ${safe.toFixed(2)}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlShell(inner: string): string {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:0 16px;line-height:1.55">${inner}</div>`.trim();
}
