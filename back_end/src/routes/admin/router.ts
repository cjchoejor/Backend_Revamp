import { Router } from "express";
import { adminEnqueueRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { getTimerEngine } from "../../services/infrastructure/timer-management-service.js";
import { adminConfigurationRouter } from "./configuration-router.js";
import { adminStaffRouter } from "./staff-router.js";
import { adminReadinessRouter } from "./readiness-router.js";
import { adminInventoryRouter } from "./inventory-router.js";
import { adminOverviewRouter } from "./overview-router.js";
import { adminIdentityRouter } from "./identity-router.js";
import { adminCommercialRouter } from "./commercial-router.js";
import { adminWorkflowRouter } from "./workflow-router.js";
import { adminTemplatesRouter } from "./templates-router.js";
import { adminFinancialRouter } from "./financial-router.js";
import { adminOperationalRouter } from "./operational-router.js";
import { adminVipRouter } from "./vip-router.js";

export const adminRouter = Router();

adminRouter.use(adminOverviewRouter);
adminRouter.use(adminIdentityRouter);
adminRouter.use(adminConfigurationRouter);
adminRouter.use(adminStaffRouter);
adminRouter.use(adminReadinessRouter);
adminRouter.use(adminInventoryRouter);
adminRouter.use(adminCommercialRouter);
adminRouter.use(adminWorkflowRouter);
adminRouter.use(adminTemplatesRouter);
adminRouter.use(adminFinancialRouter);
adminRouter.use(adminOperationalRouter);
adminRouter.use(adminVipRouter);

/** Dev helper — enqueue a timer job (L4). */
adminRouter.post("/enqueue", requireActorLevel("L4"), validateBody(adminEnqueueRequestSchema), async (req, res, next) => {
  try {
    const { jobName, data, startAfterMs } = req.body;
    const startAfter = new Date(Date.now() + (typeof startAfterMs === "number" ? startAfterMs : 0));
    const engine = await getTimerEngine();
    const jobId = await engine.schedule(jobName as never, (data ?? {}) as never, { startAfter });
    res.status(201).json({ jobId, jobName, startAfter: startAfter.toISOString() });
  } catch (e) {
    next(e);
  }
});
