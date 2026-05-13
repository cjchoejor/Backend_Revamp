import { Router } from "express";
import { adminEnqueueRequestSchema } from "../../validation/admin-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { getTimerEngine } from "../../services/infrastructure/timer-management-service.js";

export const adminRouter = Router();

// Test/admin helper: enqueue a timer job (dev-only usage).
adminRouter.post("/enqueue", requireActorLevel("L4"), validateBody(adminEnqueueRequestSchema), async (req, res, next) => {
  try {
    const { jobName, data, startAfterMs } = req.body;
    const startAfter = new Date(Date.now() + (typeof startAfterMs === "number" ? startAfterMs : 0));
    const engine = await getTimerEngine();
    const jobId = await engine.schedule(jobName as any, data ?? {}, { startAfter });
    res.status(201).json({ jobId, jobName, startAfter: startAfter.toISOString() });
  } catch (e) {
    next(e);
  }
});
