import { Router } from "express";
import { prisma } from "../../db.js";
import {
  addWorkOrderTodoRequestSchema,
  amendWorkOrderRequestSchema,
  createWorkOrderRequestSchema,
  recordWorkOrderConsumptionRequestSchema,
  updateWorkOrderTodoStatusRequestSchema,
} from "../../dtos/13-work-orders/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s7WorkOrderService from "../../services/domain/s7-work-order-service.js";

export const workOrdersRouter = Router();

workOrdersRouter.post("/work-orders", requireActorLevel("L1"), validateBody(createWorkOrderRequestSchema), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.createWorkOrder(prisma, req.actor!.actorId, req.body);
    res.json(created);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post("/work-orders/:id/todos", requireActorLevel("L1"), validateBody(addWorkOrderTodoRequestSchema), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.addToDoItem(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...req.body });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post(
  "/work-order-todos/:id/status",
  requireActorLevel("L1"),
  validateBody(updateWorkOrderTodoStatusRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s7WorkOrderService.updateToDoStatus(prisma, req.actor!.actorId, req.params.id, req.body);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

workOrdersRouter.post(
  "/work-orders/:id/consumption",
  requireActorLevel("L1"),
  validateBody(recordWorkOrderConsumptionRequestSchema),
  async (req, res, next) => {
    try {
      const created = await s7WorkOrderService.recordConsumption(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...req.body });
      res.json(created);
    } catch (e) {
      next(e);
    }
  },
);

workOrdersRouter.post("/work-orders/:id/amend", requireActorLevel("L1"), validateBody(amendWorkOrderRequestSchema), async (req, res, next) => {
  try {
    const result = await s7WorkOrderService.amendWorkOrder(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post("/work-orders/:id/close", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s7WorkOrderService.closeWorkOrder(prisma, req.params.id);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
