import { Router } from "express";
import { prisma } from "../../db.js";
import {
  acceptHandoffRequestSchema,
  createH2HandoffRequestSchema,
  createH4HandoffRequestSchema,
  fulfilHandoffRequestSchema,
  rejectHandoffRequestSchema,
} from "../../dtos/11-handoffs/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as handoffService from "../../services/domain/handoff-service.js";

export const handoffsRouter = Router();

handoffsRouter.post("/handoffs/:id/accept", requireActorLevel("L1"), validateBody(acceptHandoffRequestSchema), async (req, res, next) => {
  try {
    const updated = await handoffService.acceptHandoff(prisma, req.params.id, req.actor!.actorId, req.body.checklistCompletion);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/handoffs/:id/reject", requireActorLevel("L1"), validateBody(rejectHandoffRequestSchema), async (req, res, next) => {
  try {
    const updated = await handoffService.rejectHandoff(prisma, req.params.id, req.actor!.actorId, req.body.rejectionReason);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/entries/:id/handoffs/h2", requireActorLevel("L1"), validateBody(createH2HandoffRequestSchema), async (req, res, next) => {
  try {
    const b = req.body;
    const created = await handoffService.createH2(prisma, req.params.id, req.actor!.actorId, {
      roomNumber: b.roomNumber,
      guestProfileId: b.guestProfileId,
      deficientConditionStatus: b.deficientConditionStatus == null ? null : String(b.deficientConditionStatus),
      specialHousekeepingRequests: b.specialHousekeepingRequests,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/handoffs/:id/fulfil", requireActorLevel("L1"), validateBody(fulfilHandoffRequestSchema), async (req, res, next) => {
  try {
    const updated = await handoffService.fulfilHandoff(prisma, req.params.id, req.actor!.actorId, req.body.fulfilmentEvidence);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/entries/:id/handoffs/h4", requireActorLevel("L1"), validateBody(createH4HandoffRequestSchema), async (req, res, next) => {
  try {
    const created = await handoffService.createH4(prisma, req.params.id, req.actor!.actorId, {
      autoFulfilForSameDayDeparture: req.body.autoFulfilForSameDayDeparture === true,
      notes: req.body.notes,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});
