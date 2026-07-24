import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as configurationAdminService from "../../services/admin/configuration-admin-service.js";
import * as readinessAdminService from "../../services/admin/readiness-admin-service.js";

export const adminOverviewRouter = Router();

adminOverviewRouter.get("/overview", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const [configKeyCount, staffActive, staffL4, roomCount, readiness] = await Promise.all([
      configurationAdminService.listConfigurationKeys(prisma).then((k) => k.length),
      prisma.staffUser.count({ where: { isActive: true } }),
      prisma.staffUser.count({ where: { isActive: true, actorLevel: "L4" } }),
      prisma.room.count(),
      readinessAdminService.runReadinessCheck(prisma),
    ]);

    res.json({
      domains: 9,
      services: 26,
      configKeys: configKeyCount,
      staffActive,
      staffL4,
      roomCount,
      readiness: {
        ready: readiness.ready,
        summary: readiness.summary,
      },
    });
  } catch (e) {
    next(e);
  }
});
