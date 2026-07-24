import { Router } from "express";
import { prisma } from "../../db.js";
import { saveModeRequestSchema, savePolicyRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { requireGmRole } from "../../lib/admin/require-gm-role.js";
import * as workflowAdminService from "../../services/admin/workflow-admin-service.js";

export const adminWorkflowRouter = Router();

adminWorkflowRouter.get("/modes", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await workflowAdminService.listModes(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.get("/modes/:id", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const item = await workflowAdminService.getMode(prisma, req.params.id);
    res.json(item);
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.post("/modes", requireActorLevel("L4"), validateBody(saveModeRequestSchema), async (req, res, next) => {
  try {
    const saved = await workflowAdminService.saveMode(prisma, req.body, req.actor!.actorId);
    res.status(201).json(saved);
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.post("/modes/:id/activate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    // ACIG §6.1A.2 — custom-mode activation is a GM-specific hard requirement: re-resolve the actor
    // against StaffUser and confirm the GM/Admin role (not just header-level L4).
    await requireGmRole(prisma, req.actor!.actorId);
    const updated = await workflowAdminService.activateMode(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.post("/modes/:id/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const updated = await workflowAdminService.deactivateMode(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.get("/policies", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const activeOnly = req.query.activeOnly === "true";
    const policyId = typeof req.query.policyId === "string" ? req.query.policyId : undefined;
    const items = await workflowAdminService.listPolicies(prisma, { policyId, activeOnly });
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.post("/policies", requireActorLevel("L4"), validateBody(savePolicyRequestSchema), async (req, res, next) => {
  try {
    const saved = await workflowAdminService.savePolicy(prisma, req.body, req.actor!.actorId);
    res.status(201).json(saved);
  } catch (e) {
    next(e);
  }
});

adminWorkflowRouter.post("/policies/:policyId/deactivate", requireActorLevel("L4"), async (req, res, next) => {
  try {
    const updated = await workflowAdminService.deactivatePolicy(prisma, decodeURIComponent(req.params.policyId), req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
