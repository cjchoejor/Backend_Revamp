import { Router } from "express";
import { prisma } from "../../db.js";
import { placeProcessingLockRequestSchema } from "../../dtos/18-processing-locks/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1ProcessingLockService from "../../services/domain/s1-processing-lock-service.js";

export const processingLocksRouter = Router();

processingLocksRouter.post("/", requireActorLevel("L1"), validateBody(placeProcessingLockRequestSchema), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.placeLock(prisma, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.status(out.meta?.priorityNotice ? 200 : 201).json(out);
  } catch (e) {
    next(e);
  }
});

processingLocksRouter.post("/:id/reconfirm", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.reconfirm(prisma, req.actor!.actorId, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

processingLocksRouter.get("/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1ProcessingLockService.status(prisma, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});
