import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as noShowService from "../../services/application/no-show-service.js";

export const noShowRouter = Router();

noShowRouter.post("/entries/:id/no-show", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const result = await noShowService.determineNoShow(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

