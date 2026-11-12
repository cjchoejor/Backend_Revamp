import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { inboxAddress, listInboxEmails, readInboxEmailInFull } from "../../services/infrastructure/mail-inbox-service.js";
import { ValidationError } from "../../lib/errors.js";
import { z } from "zod";
import { validateBody } from "../../middleware/validate-body.js";
import {
  listConversation,
  listUnseenReplies,
  markConversationSeen,
  pollInboxForReplies,
  recordReplyAsAnswer,
} from "../../services/domain/guest-email-conversation-service.js";
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

/* ---------- a booking's conversation (2026-11-12) ---------- */

/** Its enquiry's emails, oldest first: their first email, what we sent, their replies. */
inboxRouter.get("/conversations/:entryId", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listConversation(prisma, req.params.entryId));
  } catch (e) {
    next(e);
  }
});

/** Look in the mailbox for replies now, then the conversation. */
inboxRouter.post("/conversations/:entryId/check", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const look = await pollInboxForReplies(prisma);
    res.json({ ...(await listConversation(prisma, req.params.entryId)), found: look.found });
  } catch (e) {
    next(e);
  }
});

inboxRouter.post("/conversations/:entryId/seen", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await markConversationSeen(prisma, req.params.entryId, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

/** Replies nobody has looked at yet, for the bell. */
inboxRouter.get("/replies/unseen", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ items: await listUnseenReplies(prisma) });
  } catch (e) {
    next(e);
  }
});

const answerSchema = z.object({ communicationId: z.string().trim().min(1) }).strict();
/** A reply recorded as the guest's answer to one of the enquiry's papers. */
inboxRouter.post("/replies/:id/answer", requireActorLevel("L1"), validateBody(answerSchema), async (req, res, next) => {
  try {
    res.json(await recordReplyAsAnswer(prisma, req.params.id, req.body.communicationId, { actorId: req.actor!.actorId, level: req.actor!.level }));
  } catch (e) {
    next(e);
  }
});
