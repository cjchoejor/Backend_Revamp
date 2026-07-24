import { Router } from "express";
import { prisma } from "../../db.js";
import { setCommercialConfigRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as financialAdminService from "../../services/admin/financial-admin-service.js";
import type { FinancialConfigKey } from "../../services/admin/financial-admin-service.js";

export const adminFinancialRouter = Router();

adminFinancialRouter.get("/financial/keys", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.json({ keys: await financialAdminService.listFinancialConfigKeys() });
  } catch (e) {
    next(e);
  }
});

adminFinancialRouter.get("/financial/:configKey", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const configKey = decodeURIComponent(req.params.configKey) as FinancialConfigKey;
    res.json(await financialAdminService.getFinancialConfig(prisma, configKey));
  } catch (e) {
    next(e);
  }
});

adminFinancialRouter.patch(
  "/financial/:configKey",
  requireActorLevel("L4"),
  validateBody(setCommercialConfigRequestSchema),
  async (req, res, next) => {
    try {
      const configKey = decodeURIComponent(req.params.configKey) as FinancialConfigKey;
      const result = await financialAdminService.setFinancialConfig(
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
