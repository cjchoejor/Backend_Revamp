import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createCommunicationTemplateRequestSchema,
  createInvoiceTemplateRequestSchema,
  createWorkOrderTemplateRequestSchema,
  saveHandoffTemplateRequestSchema,
  updateCommunicationTemplateRequestSchema,
  updateInvoiceTemplateRequestSchema,
  updateWorkOrderTemplateRequestSchema,
} from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as templateAdminService from "../../services/admin/template-admin-service.js";

export const adminTemplatesRouter = Router();

adminTemplatesRouter.get("/templates/communication", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await templateAdminService.listCommunicationTemplates(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminTemplatesRouter.post(
  "/templates/communication",
  requireActorLevel("L4"),
  validateBody(createCommunicationTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const created = await templateAdminService.createCommunicationTemplate(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.patch(
  "/templates/communication/:id",
  requireActorLevel("L4"),
  validateBody(updateCommunicationTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await templateAdminService.updateCommunicationTemplate(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.get("/templates/handoff", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await templateAdminService.listHandoffTemplates(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminTemplatesRouter.post(
  "/templates/handoff",
  requireActorLevel("L4"),
  validateBody(saveHandoffTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const saved = await templateAdminService.saveHandoffTemplate(prisma, req.body, req.actor!.actorId);
      res.status(201).json(saved);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.get("/templates/invoice", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await templateAdminService.listInvoiceTemplates(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminTemplatesRouter.post(
  "/templates/invoice",
  requireActorLevel("L4"),
  validateBody(createInvoiceTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const created = await templateAdminService.createInvoiceTemplate(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.patch(
  "/templates/invoice/:id",
  requireActorLevel("L4"),
  validateBody(updateInvoiceTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await templateAdminService.updateInvoiceTemplate(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.get("/templates/work-order", requireActorLevel("L4"), async (_req, res, next) => {
  try {
    const items = await templateAdminService.listWorkOrderTemplates(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

adminTemplatesRouter.post(
  "/templates/work-order",
  requireActorLevel("L4"),
  validateBody(createWorkOrderTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const created = await templateAdminService.createWorkOrderTemplate(prisma, req.body, req.actor!.actorId);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

adminTemplatesRouter.patch(
  "/templates/work-order/:id",
  requireActorLevel("L4"),
  validateBody(updateWorkOrderTemplateRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await templateAdminService.updateWorkOrderTemplate(prisma, req.params.id, req.body, req.actor!.actorId);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
