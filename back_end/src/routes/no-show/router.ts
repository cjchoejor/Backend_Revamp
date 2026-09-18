import { Router } from "express";
import { prisma } from "../../db.js";
import { determineNoShowRequestSchema } from "../../dtos/10-no-show/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as noShowService from "../../services/application/no-show-service.js";

export const noShowRouter = Router();

/**
 * What recording a no-show now would charge and give back (2026-09-18) — nothing written. The
 * desk shows it in the dialog before the irreversible click; the determination books exactly it.
 */
noShowRouter.get("/entries/:id/no-show-preview", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await noShowService.previewNoShow(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

noShowRouter.post("/entries/:id/no-show", requireActorLevel("L2"), validateBody(determineNoShowRequestSchema), async (req, res, next) => {
  try {
    const result = await noShowService.determineNoShow(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(result);
  } catch (e) {
    next(e);
  }
});
