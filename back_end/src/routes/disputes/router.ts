import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s7DisputeService from "../../services/domain/s7-dispute-service.js";
import { Stage } from "@prisma/client";

export const disputesRouter = Router();

disputesRouter.post("/disputes/open", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7DisputeService.openDispute(prisma, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

disputesRouter.post("/disputes/:id/close", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s7DisputeService.closeDispute(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

disputesRouter.post("/disputes/:id/gate-override", requireActorLevel("L3"), async (req, res, next) => {
  try {
    const { targetStage, freeTextReason } = req.body ?? {};
    if (targetStage !== "S8" && targetStage !== "S9") {
      next(new AppError(400, { error: "ValidationError", message: 'targetStage must be "S8" or "S9"' }));
      return;
    }
    const created = await s7DisputeService.createGateOverride(prisma, req.params.id, req.actor!.actorId, {
      targetStage: targetStage === "S9" ? Stage.S9 : Stage.S8,
      freeTextReason,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

