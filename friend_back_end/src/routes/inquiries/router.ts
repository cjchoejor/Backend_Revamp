import { Router } from "express";
import { prisma } from "../../db.js";
import {
  assignInquiryCustodianRequestSchema,
  captureCorporateContextRequestSchema,
  createInquiryRequestSchema,
  listInquiriesQuerySchema,
  parkInquiryRequestSchema,
} from "../../dtos/02-inquiries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import * as s1InquiryService from "../../services/domain/s1-inquiry-service.js";

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
