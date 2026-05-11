import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s1AvailabilityService from "../../services/domain/s1-availability-service.js";

export const availabilityRouter = Router();

availabilityRouter.post("/entries/:id/availability/query", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.params.id, req.actor!.actorId, req.actor!.level as any, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// SIG-S1 route alias
availabilityRouter.post("/availability/search", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1AvailabilityService.queryAvailability(prisma, req.body?.entryId, req.actor!.actorId, req.actor!.level as any, req.body ?? {});
    res.json({
      configurationId: out.configuration.id,
      entryId: out.configuration.entryId,
      queriedAt: out.configuration.createdAt.toISOString(),
      isStale: out.configuration.isStale,
      results: out.result,
    });
  } catch (e) {
    next(e);
  }
});

availabilityRouter.patch("/availability/configurations/:id/select", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s1AvailabilityService.selectOption(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

