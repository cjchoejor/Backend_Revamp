import { Router } from "express";
import { prisma } from "../../db.js";
import {
  closeDisputeRequestSchema,
  createDisputeGateOverrideRequestSchema,
  openDisputeRequestSchema,
  progressDisputeRequestSchema,
} from "../../dtos/12-disputes/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s7DisputeService from "../../services/domain/s7-dispute-service.js";
import { Stage } from "@prisma/client";

export const disputesRouter = Router();

disputesRouter.get("/disputes/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const d = await s7DisputeService.getDispute(prisma, req.params.id);
    res.json(d);
  } catch (e) {
    next(e);
  }
});

const openHandler = validateBody(openDisputeRequestSchema);
disputesRouter.post("/disputes", requireActorLevel("L1"), openHandler, async (req, res, next) => {
  try {
    const created = await s7DisputeService.openDispute(prisma, req.actor!.actorId, req.body, req.actor!.level);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

disputesRouter.post("/disputes/open", requireActorLevel("L1"), openHandler, async (req, res, next) => {
  try {
    const created = await s7DisputeService.openDispute(prisma, req.actor!.actorId, req.body, req.actor!.level);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

// Taking a dispute under review and resolving it are the FOM's (SIG-S9 §96, "dispute
// progression" — L2); the GM closes it. This was L1, so a front-desk call could mark a dispute
// resolved — which releases the Check-out gate — past both (2026-09-18).
disputesRouter.patch("/disputes/:id", requireActorLevel("L2"), validateBody(progressDisputeRequestSchema), async (req, res, next) => {
  try {
    const updated = await s7DisputeService.progressDispute(prisma, req.params.id, req.actor!.actorId, req.body, req.actor!.level);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

disputesRouter.post("/disputes/:id/close", requireActorLevel("L3"), validateBody(closeDisputeRequestSchema), async (req, res, next) => {
  try {
    const updated = await s7DisputeService.closeDispute(prisma, req.params.id, req.actor!.actorId, req.body, req.actor!.level);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

disputesRouter.post("/disputes/:id/gate-override", requireActorLevel("L3"), validateBody(createDisputeGateOverrideRequestSchema), async (req, res, next) => {
  try {
    const { targetStage, freeTextReason } = req.body;
    const created = await s7DisputeService.createGateOverride(prisma, req.params.id, req.actor!.actorId, {
      targetStage: targetStage === "S9" ? Stage.S9 : Stage.S8,
      freeTextReason,
    });
    res.json(created);
  } catch (e) {
    next(e);
  }
});
