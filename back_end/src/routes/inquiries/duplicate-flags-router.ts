import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s1InquiryService from "../../services/domain/s1-inquiry-service.js";

export const duplicateFlagsRouter = Router();

duplicateFlagsRouter.post("/:id/resolve", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1InquiryService.resolveDuplicateFlag(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

