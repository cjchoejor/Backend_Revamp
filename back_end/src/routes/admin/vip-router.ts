import { Router } from "express";
import { prisma } from "../../db.js";
import { saveVipRoutingRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as vipRoutingAdminService from "../../services/admin/vip-routing-admin-service.js";

export const adminVipRouter = Router();

adminVipRouter.get("/vip-routing", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await vipRoutingAdminService.listVipRoutings(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminVipRouter.post(
  "/vip-routing",
  requireActorLevel("L4"),
  validateBody(saveVipRoutingRequestSchema),
  async (req, res, next) => {
    try {
      const created = await vipRoutingAdminService.saveVipRouting(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminVipRouter.post("/vip-routing/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const updated = await vipRoutingAdminService.deactivateVipRouting(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
