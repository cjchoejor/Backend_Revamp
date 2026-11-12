import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { inboxAddress, listInboxEmails, readInboxEmailInFull } from "../../services/infrastructure/mail-inbox-service.js";
import { ValidationError } from "../../lib/errors.js";
import { enquiriesLinkedTo } from "../../services/domain/inquiry-email-thread-service.js";

/**
 * The hotel's mailbox, read only (2026-11-12): the recent emails the desk can pick an enquiry's
 * conversation from. `q` searches the sender, the subject and the first lines; `all=1` lists
 * newsletters and machine mail too.
 */
export const inboxRouter = Router();

inboxRouter.get("/emails", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 120) : "";
    const days = Number(req.query.days ?? 14);
    const includeBulk = req.query.all === "1" || req.query.all === "true";
    const fresh = req.query.fresh === "1";
    const emails = await listInboxEmails({ q, days: Number.isFinite(days) ? days : 14, includeBulk, fresh, limit: 40 });
    const linked = await enquiriesLinkedTo(prisma, emails.map((e) => e.messageId));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      mailbox: inboxAddress(),
      emails: emails.map((e) => ({ ...e, linkedTo: linked.get(e.messageId) ?? [] })),
    });
  } catch (e) {
    next(e);
  }
});

/** One email in full, to read before picking it (2026-11-12). `id` is its Message-ID. */
inboxRouter.get("/email", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    if (!id || id.length > 998) throw new ValidationError("Which email? Its id is missing");
    const email = await readInboxEmailInFull(id);
    if (!email) throw new ValidationError("That email is not in the hotel's mailbox any more");
    const linked = await enquiriesLinkedTo(prisma, [email.messageId]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ email: { ...email, linkedTo: linked.get(email.messageId) ?? [] } });
  } catch (e) {
    next(e);
  }
});
