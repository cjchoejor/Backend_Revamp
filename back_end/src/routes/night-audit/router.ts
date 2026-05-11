import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s7NightAuditService from "../../services/application/s7-night-audit-service.js";

export const nightAuditRouter = Router();

nightAuditRouter.post("/night-audit/run", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const record = await s7NightAuditService.runNightAudit(prisma, req.actor!.actorId, req.body ?? {});
    res.json(record);
  } catch (e) {
    next(e);
  }
});

