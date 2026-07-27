import { Router } from "express";
import { prisma } from "../../db.js";
import { resolveDuplicateFlagRequestSchema } from "../../dtos/02-inquiries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1InquiryService from "../../services/domain/s1-inquiry-service.js";

export const duplicateFlagsRouter = Router();

duplicateFlagsRouter.post("/:id/resolve", requireActorLevel("L1"), validateBody(resolveDuplicateFlagRequestSchema), async (req, res, next) => {
  try {
    const updated = await s1InquiryService.resolveDuplicateFlag(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
