import { Router } from "express";
import { prisma } from "../../db.js";
import { createSeasonRequestSchema, updateSeasonRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as seasonService from "../../services/admin/season-admin-service.js";

export const adminSeasonRouter = Router();

adminSeasonRouter.get("/seasons", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const items = await seasonService.listSeasons(prisma, req.query.includeInactive === "true");
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminSeasonRouter.get("/seasons/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await seasonService.getSeason(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

adminSeasonRouter.post("/seasons", requireActorLevel("L4"), validateBody(createSeasonRequestSchema), async (req, res, next) => {
  try {
    res.status(201).json(await seasonService.createSeason(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminSeasonRouter.patch("/seasons/:id", requireActorLevel("L4"), validateBody(updateSeasonRequestSchema), async (req, res, next) => {
  try {
    res.json(await seasonService.updateSeason(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminSeasonRouter.post("/seasons/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await seasonService.deactivateSeason(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminSeasonRouter.post("/seasons/:id/reactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await seasonService.reactivateSeason(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
