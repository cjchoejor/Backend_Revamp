import { Router } from "express";
import { prisma } from "../../db.js";
import { setCommercialConfigRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as operationalAdminService from "../../services/admin/operational-admin-service.js";
import type { OperationalConfigKey } from "../../services/admin/operational-admin-service.js";

export const adminOperationalRouter = Router();

adminOperationalRouter.get("/operational/keys", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.json({ keys: await operationalAdminService.listOperationalConfigKeys() });
  } catch (e) {
    next(e);
  }
});

adminOperationalRouter.get("/operational/:configKey", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const configKey = decodeURIComponent(req.params.configKey) as OperationalConfigKey;
    res.json(await operationalAdminService.getOperationalConfig(prisma, configKey));
  } catch (e) {
    next(e);
  }
});

adminOperationalRouter.patch(
  "/operational/:configKey",
  requireActorLevel("L4"),
  validateBody(setCommercialConfigRequestSchema),
  async (req, res, next) => {
    try {
      const configKey = decodeURIComponent(req.params.configKey) as OperationalConfigKey;
      const result = await operationalAdminService.setOperationalConfig(
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
