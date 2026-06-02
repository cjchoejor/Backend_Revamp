import { Router } from "express";
import { prisma } from "../../db.js";
import {
  valueOnlyRequestSchema,
  setPollingIntervalRequestSchema,
  setNoShowCutoffRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/ota-config-admin-service.js";

export const adminOtaConfigRouter = Router();
const L4 = requireActorLevel("L4");

adminOtaConfigRouter.get("/ota-config/source-flags", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getSourceFlagConfig(prisma) });
  } catch (e) {
    next(e);
  }
});
adminOtaConfigRouter.put("/ota-config/source-flags", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setSourceFlagConfig(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminOtaConfigRouter.get("/ota-config/polling-interval", L4, async (_req, res, next) => {
  try {
    res.json({ seconds: await svc.getPollingInterval(prisma) });
  } catch (e) {
    next(e);
  }
});
adminOtaConfigRouter.put("/ota-config/polling-interval", L4, validateBody(setPollingIntervalRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setPollingInterval(prisma, req.body.seconds, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminOtaConfigRouter.get("/ota-config/conflict-rules", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getConflictTriggerRules(prisma) });
  } catch (e) {
    next(e);
  }
});
adminOtaConfigRouter.put("/ota-config/conflict-rules", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setConflictTriggerRules(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminOtaConfigRouter.get("/ota-config/no-show-cutoff", L4, async (_req, res, next) => {
  try {
    res.json({ minutes: await svc.getNoShowCutoff(prisma) });
  } catch (e) {
    next(e);
  }
});
adminOtaConfigRouter.put("/ota-config/no-show-cutoff", L4, validateBody(setNoShowCutoffRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setNoShowCutoff(prisma, req.body.minutes, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminOtaConfigRouter.get("/ota-config/no-show-penalty", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getNoShowPenaltyStructure(prisma) });
  } catch (e) {
    next(e);
  }
});
adminOtaConfigRouter.put("/ota-config/no-show-penalty", L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.setNoShowPenaltyStructure(prisma, req.body.value as never, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
