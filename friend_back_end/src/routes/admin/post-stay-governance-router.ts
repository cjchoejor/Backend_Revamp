import { Router } from "express";
import { prisma } from "../../db.js";
import {
  valueOnlyRequestSchema,
  createFeedbackTemplateRequestSchema,
  updateFeedbackTemplateRequestSchema,
  setCommissionRateRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/post-stay-governance-admin-service.js";

export const adminPostStayGovernanceRouter = Router();
const L4 = requireActorLevel("L4");

// Feedback survey templates
adminPostStayGovernanceRouter.get("/post-stay/feedback-templates", L4, async (req, res, next) => {
  try {
    const items = await svc.listFeedbackTemplates(prisma, req.query.includeInactive === "true");
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});
adminPostStayGovernanceRouter.post("/post-stay/feedback-templates", L4, validateBody(createFeedbackTemplateRequestSchema), async (req, res, next) => {
  try {
    res.status(201).json(await svc.createFeedbackTemplate(prisma, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
adminPostStayGovernanceRouter.patch("/post-stay/feedback-templates/:id", L4, validateBody(updateFeedbackTemplateRequestSchema), async (req, res, next) => {
  try {
    res.json(await svc.updateFeedbackTemplate(prisma, req.params.id, req.body, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
adminPostStayGovernanceRouter.post("/post-stay/feedback-templates/:id/deactivate", L4, async (req, res, next) => {
  try {
    res.json(await svc.deactivateFeedbackTemplate(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});
adminPostStayGovernanceRouter.post("/post-stay/feedback-templates/:id/reactivate", L4, async (req, res, next) => {
  try {
    res.json(await svc.reactivateFeedbackTemplate(prisma, req.params.id, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

// Keyed governance surfaces
function keyedPair(path: string, getter: (p: typeof prisma) => Promise<unknown>, setter: (p: typeof prisma, v: never, a: string) => Promise<unknown>) {
  adminPostStayGovernanceRouter.get(path, L4, async (_req, res, next) => {
    try {
      res.json({ value: await getter(prisma) });
    } catch (e) {
      next(e);
    }
  });
  adminPostStayGovernanceRouter.put(path, L4, validateBody(valueOnlyRequestSchema), async (req, res, next) => {
    try {
      res.json(await setter(prisma, req.body.value as never, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  });
}

keyedPair("/post-stay/platform-links", svc.getPlatformLinks, svc.setPlatformLinks);
keyedPair("/post-stay/government-portal", svc.getGovernmentPortalConfig, svc.setGovernmentPortalConfig);
keyedPair("/post-stay/commission-basis", svc.getCommissionBasis, svc.setCommissionBasis);
keyedPair("/post-stay/identity-document-types", svc.listIdentityDocumentTypes, svc.updateIdentityDocumentTypes);
keyedPair("/post-stay/identity-retention", svc.getIdentityRetentionPeriod, svc.setIdentityRetentionPeriod);

// Commission rate cross-write
adminPostStayGovernanceRouter.put("/post-stay/agent-commission/:agentProfileId", L4, validateBody(setCommissionRateRequestSchema), async (req, res, next) => {
  try {
    res.json(
      await svc.setCommissionRateOnAgentProfile(prisma, req.params.agentProfileId, req.body.rate, req.actor!.actorId, req.body.effectiveFrom ?? undefined),
    );
  } catch (e) {
    next(e);
  }
});
