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
import { adminRatePlanRouter } from "./rate-plan-router.js";
import { adminSeasonRouter } from "./season-router.js";
import { adminPackageRouter } from "./package-router.js";
import { adminCancellationPolicyRouter } from "./cancellation-policy-router.js";
import { adminCommercialThresholdRouter } from "./commercial-threshold-router.js";
import { adminOtaConfigRouter } from "./ota-config-router.js";
import { adminAiAgentConfigRouter } from "./ai-agent-config-router.js";
import { adminCommunicationConfigRouter } from "./communication-config-router.js";
import { adminPostStayGovernanceRouter } from "./post-stay-governance-router.js";
import { adminAuditTrailRouter } from "./audit-trail-router.js";
import { adminEmailRouter } from "./email-router.js";
import { adminIdPrefixRouter } from "./id-prefix-router.js";

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
adminRouter.use(adminRatePlanRouter);
adminRouter.use(adminSeasonRouter);
adminRouter.use(adminPackageRouter);
adminRouter.use(adminCancellationPolicyRouter);
adminRouter.use(adminCommercialThresholdRouter);
adminRouter.use(adminOtaConfigRouter);
adminRouter.use(adminAiAgentConfigRouter);
adminRouter.use(adminCommunicationConfigRouter);
adminRouter.use(adminPostStayGovernanceRouter);
adminRouter.use(adminAuditTrailRouter);
adminRouter.use(adminEmailRouter);
adminRouter.use(adminIdPrefixRouter);

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
