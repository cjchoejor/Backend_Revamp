import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as readinessAdminService from "../../services/admin/readiness-admin-service.js";

export const adminReadinessRouter = Router();

// L4 only per ACIG §6.2 — the readiness matrix exposes missing config, admin-writable surfaces,
// staff counts, and S9 readiness. Was L1 by mistake (inconsistent with the sibling POST run route).
adminReadinessRouter.get("/readiness", requireActorLevel("L4"), async (_req, res, next) => {
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
