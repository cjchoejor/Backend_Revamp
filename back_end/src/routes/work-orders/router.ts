import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s7WorkOrderService from "../../services/domain/s7-work-order-service.js";
import { WorkOrderToDoStatus } from "@prisma/client";

export const workOrdersRouter = Router();

workOrdersRouter.post("/work-orders", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.createWorkOrder(prisma, req.actor!.actorId, req.body ?? {});
    res.json(created);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post("/work-orders/:id/todos", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.addToDoItem(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...(req.body ?? {}) });
    res.json(created);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post("/work-order-todos/:id/status", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { status, cancelReason } = req.body ?? {};
    if (!status || typeof status !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "status is required" }));
      return;
    }
    if (!Object.values(WorkOrderToDoStatus).includes(status as WorkOrderToDoStatus)) {
      next(new AppError(400, { error: "ValidationError", message: `status must be one of: ${Object.values(WorkOrderToDoStatus).join(", ")}` }));
      return;
    }
    const updated = await s7WorkOrderService.updateToDoStatus(prisma, req.actor!.actorId, req.params.id, { status: status as WorkOrderToDoStatus, cancelReason });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

workOrdersRouter.post("/work-orders/:id/consumption", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s7WorkOrderService.recordConsumption(prisma, req.actor!.actorId, { workOrderId: req.params.id, ...(req.body ?? {}) });
    res.json(created);
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

