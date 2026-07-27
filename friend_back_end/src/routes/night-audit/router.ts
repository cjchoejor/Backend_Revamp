import { Router } from "express";
import { prisma } from "../../db.js";
import { nightAuditOperatingDateParamSchema, runNightAuditRequestSchema } from "../../dtos/15-night-audit/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import * as s7NightAuditService from "../../services/application/s7-night-audit-service.js";

export const nightAuditRouter = Router();

/** Avoid `GET /night-audit/:date` colliding with the `run` path segment; use explicit `operating-date`. */
nightAuditRouter.get(
  "/night-audit/operating-date/:operatingDate",
  requireActorLevel("L2"),
  async (req, res, next) => {
    try {
      const parsed = nightAuditOperatingDateParamSchema.safeParse(req.params);
      if (!parsed.success) {
        next(new ValidationError("operatingDate must be YYYY-MM-DD", parsed.error.flatten()));
        return;
      }
      const record = await s7NightAuditService.getNightAuditRecordByOperatingDate(prisma, parsed.data.operatingDate);
      res.json(record);
    } catch (e) {
      next(e);
    }
  },
);

nightAuditRouter.post("/night-audit/run", requireActorLevel("L2"), validateBody(runNightAuditRequestSchema), async (req, res, next) => {
  try {
    const record = await s7NightAuditService.runNightAudit(prisma, req.actor!.actorId, req.body);
    res.json(record);
  } catch (e) {
    next(e);
  }
});
