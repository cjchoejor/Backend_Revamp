import { Router } from "express";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { getTimerEngine } from "../../services/infrastructure/timer-management-service.js";

export const adminRouter = Router();

// Test/admin helper: enqueue a timer job (dev-only usage).
adminRouter.post("/enqueue", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const { jobName, data, startAfterMs } = req.body ?? {};
    if (typeof jobName !== "string" || !jobName.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "jobName is required" }));
      return;
    }
    const startAfter = new Date(Date.now() + (typeof startAfterMs === "number" ? startAfterMs : 0));
    const engine = await getTimerEngine();
    const jobId = await engine.schedule(jobName.trim() as any, data ?? {}, { startAfter });
    res.status(201).json({ jobId, jobName: jobName.trim(), startAfter: startAfter.toISOString() });
  } catch (e) {
    next(e);
  }
});

