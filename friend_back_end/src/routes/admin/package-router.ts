import { Router } from "express";
import { prisma } from "../../db.js";
import { createPackageRequestSchema, updatePackageRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as packageService from "../../services/admin/package-admin-service.js";

export const adminPackageRouter = Router();

adminPackageRouter.get("/packages", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const items = await packageService.listPackages(prisma, req.query.includeInactive === "true");
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminPackageRouter.get("/packages/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await packageService.getPackage(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

adminPackageRouter.post("/packages", requireActorLevel("L4"), validateBody(createPackageRequestSchema), async (req, res, next) => {
  try {
    res.status(201).json(await packageService.createPackage(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminPackageRouter.patch("/packages/:id", requireActorLevel("L4"), validateBody(updatePackageRequestSchema), async (req, res, next) => {
  try {
    res.json(await packageService.updatePackage(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminPackageRouter.post("/packages/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await packageService.deactivatePackage(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

adminPackageRouter.post("/packages/:id/reactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await packageService.reactivatePackage(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
