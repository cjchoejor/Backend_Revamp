import { Router } from "express";
import { prisma } from "../../db.js";
import { setCommercialConfigRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as commercialAdminService from "../../services/admin/commercial-admin-service.js";
import type { CommercialConfigKey } from "../../services/admin/commercial-admin-service.js";

export const adminCommercialRouter = Router();

adminCommercialRouter.get("/commercial/keys", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const keys = await commercialAdminService.listCommercialConfigKeys();
    res.json({ keys });
  } catch (e) {
    next(e);
  }
});

adminCommercialRouter.get("/commercial/:configKey", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const configKey = decodeURIComponent(req.params.configKey) as CommercialConfigKey;
    const active = await commercialAdminService.getCommercialConfig(prisma, configKey);
    res.json(active);
  } catch (e) {
    next(e);
  }
});

adminCommercialRouter.patch(
  "/commercial/:configKey",
  requireActorLevel("L4"),
  validateBody(setCommercialConfigRequestSchema),
  async (req, res, next) => {
    try {
      const configKey = decodeURIComponent(req.params.configKey) as CommercialConfigKey;
      const result = await commercialAdminService.setCommercialConfig(
        prisma,
        configKey,
        req.body.configValue as never,
        req.actor!.actorId,
        req.body.notes,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
