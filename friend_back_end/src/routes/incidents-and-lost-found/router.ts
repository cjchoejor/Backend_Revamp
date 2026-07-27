import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { createLostAndFoundRequestSchema } from "../../dtos/16-incidents-and-lost-found/request-schemas.js";
import * as lostFoundService from "../../services/domain/lost-found-service.js";

export const incidentsAndLostFoundRouter = Router();

// Minimal Lost+Found route (SIG-S9 W30 anchor).
incidentsAndLostFoundRouter.post(
  "/lost-found",
  requireActorLevel("L1"),
  validateBody(createLostAndFoundRequestSchema),
  async (req, res, next) => {
    try {
      const rec = await lostFoundService.createLostAndFoundRecord(prisma, req.actor!.actorId, req.body);
      res.status(201).json(rec);
    } catch (e) {
      next(e);
    }
  },
);

