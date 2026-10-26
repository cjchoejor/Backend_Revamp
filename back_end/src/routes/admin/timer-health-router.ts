/**
 * System health: the timers that failed (2026-10-26). Read-only — the hourly sweep in the
 * workers does the sending again (services/infrastructure/timer-failure-sweep-service.ts);
 * this lists every timer job that failed in the last week and what the sweep did about it.
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { describeTimerFailures } from "../../services/infrastructure/timer-failure-sweep-service.js";

export const adminTimerHealthRouter = Router();

adminTimerHealthRouter.get("/timer-failures", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await describeTimerFailures(prisma));
  } catch (e) {
    next(e);
  }
});
