import { Router } from "express";
import { prisma } from "../../db.js";
import {
  assignInquiryCustodianRequestSchema,
  captureCorporateContextRequestSchema,
  createInquiryRequestSchema,
  listInquiriesQuerySchema,
  parkInquiryRequestSchema,
  updateInquiryNotesRequestSchema,
} from "../../dtos/02-inquiries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import { cleanCoordinators } from "../../lib/admin/contact-list.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import * as s1InquiryService from "../../services/domain/s1-inquiry-service.js";
import { z } from "zod";
import { clearInquiryEmail, linkInquiryEmail } from "../../services/domain/inquiry-email-thread-service.js";

export const inquiriesRouter = Router();

inquiriesRouter.get("/", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const parsed = listInquiriesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    const items = await s1InquiryService.listInquiries(prisma, parsed.data);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.get("/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const inquiry = await s1InquiryService.getInquiryById(prisma, req.params.id);
    res.json(inquiry);
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.post("/", requireActorLevel("L1"), validateBody(createInquiryRequestSchema), async (req, res, next) => {
  try {
    if (req.body.caller) req.body.caller.phone = cleanPhone(req.body.caller.phone, "The caller's phone");
    if (req.body.partyContacts) req.body.partyContacts = cleanCoordinators(req.body.partyContacts);
    const created = await s1InquiryService.createInquiry(prisma, req.actor!.actorId, req.actor!.level, req.body);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.post(
  "/:id/assign-custodian",
  requireActorLevel("L1"),
  validateBody(assignInquiryCustodianRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s1InquiryService.assignInquiryCustodian(
        prisma,
        req.params.id,
        req.actor!.actorId,
        req.actor!.level,
        req.body.newCustodianId,
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

inquiriesRouter.post("/:id/park", requireActorLevel("L1"), validateBody(parkInquiryRequestSchema), async (req, res, next) => {
  try {
    const out = await s1InquiryService.parkInquiry(prisma, req.params.id, req.actor!.actorId, req.body.reason);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.post("/:id/unpark", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1InquiryService.unparkInquiry(prisma, req.params.id, req.actor!.actorId);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.patch("/:id/corporate-context", requireActorLevel("L1"), validateBody(captureCorporateContextRequestSchema), async (req, res, next) => {
  try {
    const updated = await s1InquiryService.captureCorporateContext(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// Edit the special-preference note (Inquiry.notes) from any stage — L1+, stage-agnostic.
inquiriesRouter.patch("/:id/notes", requireActorLevel("L1"), validateBody(updateInquiryNotesRequestSchema), async (req, res, next) => {
  try {
    const updated = await s1InquiryService.updateInquiryNotes(prisma, req.params.id, req.actor!.actorId, req.body.notes);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// The guest's own email (2026-11-12): every paper of every stay on the enquiry replies inside it.
const linkEmailSchema = z.object({ messageId: z.string().trim().min(3).max(998) }).strict();
inquiriesRouter.post("/:id/email-thread", requireActorLevel("L1"), validateBody(linkEmailSchema), async (req, res, next) => {
  try {
    const thread = await linkInquiryEmail(prisma, req.params.id, req.body.messageId, { actorId: req.actor!.actorId, level: req.actor!.level });
    res.json({ emailThread: thread });
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.post("/:id/email-thread/clear", requireActorLevel("L1"), async (req, res, next) => {
  try {
    await clearInquiryEmail(prisma, req.params.id, { actorId: req.actor!.actorId, level: req.actor!.level });
    res.json({ emailThread: null });
  } catch (e) {
    next(e);
  }
});
