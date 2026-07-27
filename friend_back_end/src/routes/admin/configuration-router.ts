import { Router } from "express";
import { prisma } from "../../db.js";
import { setConfigurationRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as configurationAdminService from "../../services/admin/configuration-admin-service.js";

export const adminConfigurationRouter = Router();

adminConfigurationRouter.get("/configuration/keys", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const keys = await configurationAdminService.listConfigurationKeys(prisma);
    res.json({ keys });
  } catch (e) {
    next(e);
  }
});

adminConfigurationRouter.get("/configuration/:configKey", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const configKey = decodeURIComponent(req.params.configKey);
    const active = await configurationAdminService.getActiveConfiguration(prisma, configKey);
    res.json(active);
  } catch (e) {
    next(e);
  }
});

adminConfigurationRouter.get("/configuration/:configKey/history", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const configKey = decodeURIComponent(req.params.configKey);
    const history = await configurationAdminService.listConfigurationHistory(prisma, configKey);
    res.json({ configKey, history });
  } catch (e) {
    next(e);
  }
});

adminConfigurationRouter.patch(
  "/configuration/:configKey",
  requireActorLevel("L4"),
  validateBody(setConfigurationRequestSchema),
  async (req, res, next) => {
    try {
      const configKey = decodeURIComponent(req.params.configKey);
      const result = await configurationAdminService.setConfiguration(prisma, {
        configKey,
        configValue: req.body.configValue,
        actorId: req.actor!.actorId,
        notes: req.body.notes,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
