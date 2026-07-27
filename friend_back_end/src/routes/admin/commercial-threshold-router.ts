import { Router } from "express";
import { prisma } from "../../db.js";
import {
  valueOnlyRequestSchema,
  setDiscountThresholdsRequestSchema,
  setCreditCeilingThresholdsRequestSchema,
  setOverbookingLimitsRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/commercial-threshold-admin-service.js";

export const adminCommercialThresholdRouter = Router();
const L4 = requireActorLevel("L4");

adminCommercialThresholdRouter.get("/commercial-thresholds/discount", L4, async (_req, res, next) => {
  try {
    res.json(await svc.getDiscountThresholds(prisma));
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/discount", L4, validateBody(setDiscountThresholdsRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setDiscountThresholds(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/foc", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getFOCConfiguration(prisma) });
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/foc", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setFOCConfiguration(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/confirmation-authority", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getConfirmationAuthorityThresholds(prisma) });
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/confirmation-authority", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setConfirmationAuthorityThresholds(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/overbooking", L4, async (_req, res, next) => {
  try {
    res.json({ maxAllowedRooms: await svc.getOverbookingLimits(prisma) });
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/overbooking", L4, validateBody(setOverbookingLimitsRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setOverbookingLimits(prisma, req.body.maxAllowedRooms, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/credit-ceiling", L4, async (_req, res, next) => {
  try {
    res.json(await svc.getCreditCeilingThresholds(prisma));
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/credit-ceiling", L4, validateBody(setCreditCeilingThresholdsRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setCreditCeilingThresholds(prisma, req.body as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/speculative-hold", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getSpeculativeHoldThresholds(prisma) });
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/speculative-hold", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setSpeculativeHoldThresholds(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminCommercialThresholdRouter.get("/commercial-thresholds/write-off", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getWriteOffAuthorityThresholds(prisma) });
  } catch (e) {
    next(e);
  }
});
adminCommercialThresholdRouter.put("/commercial-thresholds/write-off", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setWriteOffAuthorityThresholds(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
