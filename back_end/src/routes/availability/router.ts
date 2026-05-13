import { Router } from "express";
import { prisma } from "../../db.js";
import {
  queryAvailabilityByEntryRequestSchema,
  queryAvailabilitySearchRequestSchema,
  selectAvailabilityOptionRequestSchema,
} from "../../dtos/04-availability/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1AvailabilityService from "../../services/domain/s1-availability-service.js";

export const availabilityRouter = Router();

availabilityRouter.get("/availability/configurations/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.getConfiguration(prisma, req.params.id);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

availabilityRouter.post("/availability/configurations/:id/recall", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.recallConfiguration(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level as "L1" | "L2" | "L3" | "L4" | "SYSTEM",
    );
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
      ...("spaceAllocation" in out && out.spaceAllocation ? { spaceAllocation: out.spaceAllocation } : {}),
    });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.post(
  "/entries/:id/availability/query",
  requireActorLevel("L1"),
  validateBody(queryAvailabilityByEntryRequestSchema),
  async (req, res, next) => {
    try {
      const out = await s1AvailabilityService.queryAvailability(prisma, req.params.id, req.actor!.actorId, req.actor!.level as any, req.body);
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);

// SIG-S1 route alias
availabilityRouter.post("/availability/search", requireActorLevel("L1"), validateBody(queryAvailabilitySearchRequestSchema), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.body.entryId, req.actor!.actorId, req.actor!.level as any, req.body);
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
      ...("spaceAllocation" in out && out.spaceAllocation ? { spaceAllocation: out.spaceAllocation } : {}),
    });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.patch(
  "/availability/configurations/:id/select",
  requireActorLevel("L1"),
  validateBody(selectAvailabilityOptionRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s1AvailabilityService.selectOption(prisma, req.params.id, req.actor!.actorId, req.body);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
