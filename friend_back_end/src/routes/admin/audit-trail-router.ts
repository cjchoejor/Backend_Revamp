import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { queryTraceEvents } from "../../services/infrastructure/trace-query-service.js";

export const adminAuditTrailRouter = Router();

/** ACIG audit-visibility surface — read-only filtered view of the trace_events log. */
adminAuditTrailRouter.get("/audit-events", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const q = req.query;
    const parseDate = (v: unknown) => {
      if (typeof v !== "string" || !v.trim()) return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const num = (v: unknown) => (typeof v === "string" && v.trim() ? Number(v) : undefined);

    const result = await queryTraceEvents(prisma, {
      actorId: str(q.actorId),
      entityType: str(q.entityType),
      entityId: str(q.entityId),
      eventType: str(q.eventType),
      from: parseDate(q.from),
      to: parseDate(q.to),
      limit: num(q.limit),
      offset: num(q.offset),
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
