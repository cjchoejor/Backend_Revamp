import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as readinessAdminService from "../../services/admin/readiness-admin-service.js";

export const adminReadinessRouter = Router();

adminReadinessRouter.get("/readiness", requireActorLevel("L1"), async (_req, res, next) => {
  try {
    const report = await readinessAdminService.runReadinessCheck(prisma);
    res.json(report);
  } catch (e) {
    next(e);
  }
});

adminReadinessRouter.post("/readiness/run", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const report = await readinessAdminService.runReadinessCheck(prisma);
    res.json(report);
  } catch (e) {
    next(e);
  }
});
