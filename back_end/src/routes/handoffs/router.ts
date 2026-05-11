import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as handoffService from "../../services/domain/handoff-service.js";

export const handoffsRouter = Router();

handoffsRouter.post("/handoffs/:id/accept", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.acceptHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.checklistCompletion);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/handoffs/:id/reject", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const reason = req.body?.rejectionReason;
    if (typeof reason !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "rejectionReason is required" }));
      return;
    }
    const updated = await handoffService.rejectHandoff(prisma, req.params.id, req.actor!.actorId, reason);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/entries/:id/handoffs/h2", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const roomNumber = typeof b.roomNumber === "string" ? b.roomNumber : null;
    if (!roomNumber?.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "roomNumber is required" }));
      return;
    }
    const created = await handoffService.createH2(prisma, req.params.id, req.actor!.actorId, {
      roomNumber: roomNumber.trim(),
      guestProfileId: b.guestProfileId,
      deficientConditionStatus: b.deficientConditionStatus == null ? null : String(b.deficientConditionStatus),
      specialHousekeepingRequests: b.specialHousekeepingRequests,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/handoffs/:id/fulfil", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.fulfilHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.fulfilmentEvidence);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

handoffsRouter.post("/entries/:id/handoffs/h4", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const created = await handoffService.createH4(prisma, req.params.id, req.actor!.actorId, {
      autoFulfilForSameDayDeparture: b.autoFulfilForSameDayDeparture === true,
      notes: typeof b.notes === "string" ? b.notes : undefined,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

