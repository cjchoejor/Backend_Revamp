import { Router } from "express";
import { prisma } from "../../db.js";
import { nightAuditOperatingDateParamSchema, runNightAuditRequestSchema } from "../../dtos/15-night-audit/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
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

/**
 * Has this night been audited — the answer alone, for the whole desk (2026-09-18).
 *
 * The full record above carries the night's folio lines and anomalies across the whole hotel, so
 * it is the FOM's. But the Stay and Check-out steps gate on "has the final night been audited",
 * and a front-desk user's read of the full record was refused, so the gate stayed shut for them
 * however many times the FOM ran the audit. This answers that question and nothing more.
 */
nightAuditRouter.get(
  "/night-audit/operating-date/:operatingDate/status",
  requireActorLevel("L1"),
  async (req, res, next) => {
    try {
      const parsed = nightAuditOperatingDateParamSchema.safeParse(req.params);
      if (!parsed.success) {
        next(new ValidationError("operatingDate must be YYYY-MM-DD", parsed.error.flatten()));
        return;
      }
      // A night nobody has audited yet is an answer ("not yet"), not a missing resource.
      const record = await s7NightAuditService
        .getNightAuditRecordByOperatingDate(prisma, parsed.data.operatingDate)
        .catch((e) => {
          if (e instanceof NotFoundError) return null;
          throw e;
        });
      if (!record) {
        res.json(null);
        return;
      }
      res.json({
        id: record.id,
        operatingDate: record.operatingDate,
        runStatus: record.runStatus,
        entriesProcessed: record.entriesProcessedCount,
        createdAt: record.createdAt,
      });
    } catch (e) {
      next(e);
    }
  },
);

nightAuditRouter.post("/night-audit/run", requireActorLevel("L2"), validateBody(runNightAuditRequestSchema), async (req, res, next) => {
  try {
    const body = req.body as { operatingDate: string; entryId?: string };
    // From a booking's Stay step the run is that booking's alone (2026-09-25); the hotel-wide
    // run is the 08:00 schedule's, or a call with no booking named.
    const out = body.entryId
      ? await s7NightAuditService.runNightAuditForEntry(prisma, req.actor!.actorId, { operatingDate: body.operatingDate, entryId: body.entryId })
      : await s7NightAuditService.runNightAudit(prisma, req.actor!.actorId, { operatingDate: body.operatingDate });
    res.json(out);
  } catch (e) {
    next(e);
  }
});
