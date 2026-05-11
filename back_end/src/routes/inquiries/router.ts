import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s1InquiryService from "../../services/domain/s1-inquiry-service.js";

export const inquiriesRouter = Router();

inquiriesRouter.post("/", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s1InquiryService.createInquiry(prisma, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

inquiriesRouter.post("/:id/park", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1InquiryService.parkInquiry(prisma, req.params.id, req.actor!.actorId, req.body?.reason);
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

inquiriesRouter.patch("/:id/corporate-context", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1InquiryService.captureCorporateContext(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

