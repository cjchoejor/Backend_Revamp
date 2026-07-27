import { Router } from "express";
import { prisma } from "../../db.js";
import { determineNoShowRequestSchema } from "../../dtos/10-no-show/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as noShowService from "../../services/application/no-show-service.js";

export const noShowRouter = Router();

noShowRouter.post("/entries/:id/no-show", requireActorLevel("L2"), validateBody(determineNoShowRequestSchema), async (req, res, next) => {
  try {
    const result = await noShowService.determineNoShow(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(result);
  } catch (e) {
    next(e);
  }
});
