import { Router } from "express";
import { prisma } from "../../db.js";
import {
  cancellationChargesRequestSchema,
  createCancellationPolicyRequestSchema,
  updateCancellationPolicyRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as cancellationPolicyService from "../../services/admin/cancellation-policy-admin-service.js";

export const adminCancellationPolicyRouter = Router();

adminCancellationPolicyRouter.get("/cancellation-policies", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const items = await cancellationPolicyService.listPolicies(prisma, req.query.includeInactive === "true");
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

// What the desk really charges (`cancellation.policyTiers`). Before /:id, which would take "charges" for an id.
adminCancellationPolicyRouter.get("/cancellation-policies/charges", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    res.json(await cancellationPolicyService.getCancellationCharges(prisma));
  } catch (e) {
    next(e);
  }
});

adminCancellationPolicyRouter.put(
  "/cancellation-policies/charges",
  requireActorLevel("L4"),
  validateBody(cancellationChargesRequestSchema),
  async (req, res, next) => {
    try {
      res.json(await cancellationPolicyService.setCancellationCharges(prisma, req.body.value, req.actor!.actorId, req.body.notes));
    } catch (e) {
      next(e);
    }
  },
);

adminCancellationPolicyRouter.get("/cancellation-policies/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    res.json(await cancellationPolicyService.getPolicy(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

adminCancellationPolicyRouter.post(
  "/cancellation-policies",
  requireActorLevel("L4"),
  validateBody(createCancellationPolicyRequestSchema),
  async (req, res, next) => {
    try {
      res.status(201).json(await cancellationPolicyService.createPolicy(prisma, req.body, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);

adminCancellationPolicyRouter.patch(
  "/cancellation-policies/:id",
  requireActorLevel("L4"),
  validateBody(updateCancellationPolicyRequestSchema),
  async (req, res, next) => {
    try {
      res.json(await cancellationPolicyService.updatePolicy(prisma, req.params.id, req.body, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);

adminCancellationPolicyRouter.post(
  "/cancellation-policies/:id/deactivate",
  requireActorLevel("L4"),
  async (req, res, next) => {
    try {
      res.json(await cancellationPolicyService.deactivatePolicy(prisma, req.params.id, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);

adminCancellationPolicyRouter.post(
  "/cancellation-policies/:id/reactivate",
  requireActorLevel("L4"),
  async (req, res, next) => {
    try {
      res.json(await cancellationPolicyService.reactivatePolicy(prisma, req.params.id, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);
