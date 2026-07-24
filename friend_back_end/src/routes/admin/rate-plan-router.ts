import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createRatePlanRequestSchema,
  updateRatePlanRequestSchema,
  setWalkInRatePlanRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as ratePlanService from "../../services/admin/rate-plan-admin-service.js";

export const adminRatePlanRouter = Router();

adminRatePlanRouter.get("/rate-plans", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const items = await ratePlanService.listRatePlans(prisma, includeInactive);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminRatePlanRouter.get("/rate-plans/walk-in", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.json(await ratePlanService.getWalkInRatePlan(prisma));
  } catch (e) {
    next(e);
  }
});

adminRatePlanRouter.put(
  "/rate-plans/walk-in",
  requireActorLevel("L4"),
  validateBody(setWalkInRatePlanRequestSchema),
  async (req, res, next) => {
    try {
      const result = await ratePlanService.setWalkInRatePlan(prisma, req.body.ratePlanId, req.actor!.actorId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

adminRatePlanRouter.get("/rate-plans/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await ratePlanService.getRatePlan(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

adminRatePlanRouter.post(
  "/rate-plans",
  requireActorLevel("L4"),
  validateBody(createRatePlanRequestSchema),
  async (req, res, next) => {
    try {
      const created = await ratePlanService.createRatePlan(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminRatePlanRouter.patch(
  "/rate-plans/:id",
  requireActorLevel("L4"),
  validateBody(updateRatePlanRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await ratePlanService.updateRatePlan(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminRatePlanRouter.post("/rate-plans/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await ratePlanService.deactivateRatePlan(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminRatePlanRouter.post("/rate-plans/:id/reactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await ratePlanService.reactivateRatePlan(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
