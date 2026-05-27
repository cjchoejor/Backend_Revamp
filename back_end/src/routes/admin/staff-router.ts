import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createStaffRequestSchema,
  resetStaffPinRequestSchema,
  updateStaffRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as staffAdminService from "../../services/admin/staff-admin-service.js";

export const adminStaffRouter = Router();

adminStaffRouter.get("/staff", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const items = await staffAdminService.listStaff(prisma, { includeInactive });
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminStaffRouter.get("/staff/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const item = await staffAdminService.getStaff(prisma, req.params.id);
    res.json(item);
  } catch (e) {
    next(e);
  }
});

adminStaffRouter.post(
  "/staff",
  requireActorLevel("L4"),
  validateBody(createStaffRequestSchema),
  async (req, res, next) => {
    try {
      const created = await staffAdminService.createStaff(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminStaffRouter.patch(
  "/staff/:id",
  requireActorLevel("L4"),
  validateBody(updateStaffRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await staffAdminService.updateStaff(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminStaffRouter.post(
  "/staff/:id/reset-pin",
  requireActorLevel("L4"),
  validateBody(resetStaffPinRequestSchema),
  async (req, res, next) => {
    try {
      const result = await staffAdminService.resetStaffPin(prisma, req.params.id, req.body.pin, req.actor!.actorId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

adminStaffRouter.post("/staff/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const result = await staffAdminService.deactivateStaff(prisma, req.params.id, req.actor!.actorId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});
