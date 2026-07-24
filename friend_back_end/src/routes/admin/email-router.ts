/**
 * Admin email routes. Phase 1: a test-send endpoint + a verify endpoint so L4 can confirm
 * SMTP works before we wire stage events to send real guest emails.
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { sendTestEmailRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { sendEmail, verifyTransport } from "../../services/infrastructure/email-service.js";

export const adminEmailRouter = Router();

/** Confirm SMTP transporter can authenticate. Does NOT send anything. */
adminEmailRouter.get("/email/verify", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const result = await verifyTransport();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/** Send a test email. Honours EMAIL_REDIRECT_ALL_TO and threading anchors. */
adminEmailRouter.post(
  "/email/test-send",
  requireActorLevel("L4"),
  validateBody(sendTestEmailRequestSchema),
  async (req, res, next) => {
    try {
      const body = req.body as {
        to: string;
        subject: string;
        body: string;
        threadEntryId?: string;
        threadReadableId?: string;
      };
      const result = await sendEmail(prisma, {
        to: body.to,
        subject: body.subject,
        text: body.body,
        html: `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(body.body)}</div>`,
        threadEntryId: body.threadEntryId,
        threadReadableId: body.threadReadableId,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
