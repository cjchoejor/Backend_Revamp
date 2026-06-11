import type { PrismaClient } from "@prisma/client";
import { Prisma, WorkOrderToDoStatus } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";

export async function createWorkOrder(prisma: PrismaClient, actorId: string, input: { entryId: string }) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  return prisma.$transaction(async (tx) => {
    const workOrderId = await allocateReadableId(tx, "WORK_ORDER" as const);
    return tx.workOrder.create({
      data: { id: workOrderId, entryId: input.entryId, createdBy: actorId },
      include: { todoItems: true },
    });
  });
}

export async function addToDoItem(
  prisma: PrismaClient,
  actorId: string,
  input: { workOrderId: string; title: string; dueAt?: string },
) {
  if (!input.workOrderId?.trim()) throw new ValidationError("workOrderId is required");
  if (!input.title?.trim()) throw new ValidationError("title is required");
  const dueAt = input.dueAt ? new Date(input.dueAt) : undefined;
  if (input.dueAt && Number.isNaN(dueAt?.getTime())) throw new ValidationError("dueAt must be a valid ISO date");

  return prisma.workOrderToDoItem.create({
    data: { workOrderId: input.workOrderId, title: input.title, dueAt, createdBy: actorId },
  });
}

export async function updateToDoStatus(
  prisma: PrismaClient,
  actorId: string,
  todoId: string,
  input: { status: WorkOrderToDoStatus; cancelReason?: string },
) {
  if (!input.status) throw new ValidationError("status is required");
  if (input.status === WorkOrderToDoStatus.CANCELLED && !input.cancelReason?.trim()) {
    throw new ValidationError("cancelReason is required when status is CANCELLED");
  }
  return prisma.workOrderToDoItem.update({
    where: { id: todoId },
    data: { status: input.status, updatedBy: actorId, cancelReason: input.status === WorkOrderToDoStatus.CANCELLED ? input.cancelReason : null },
  });
}

export async function recordConsumption(
  prisma: PrismaClient,
  actorId: string,
  input: {
    workOrderId: string;
    itemCode: string;
    quantity: number;
    notes?: string;
    isOverAllocation?: boolean;
    overAllocationAcknowledgedBy?: string;
  },
) {
  if (!input.workOrderId?.trim()) throw new ValidationError("workOrderId is required");
  if (!input.itemCode?.trim()) throw new ValidationError("itemCode is required");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new ValidationError("quantity must be a positive integer");

  return prisma.workOrderConsumptionRecord.create({
    data: {
      workOrderId: input.workOrderId,
      itemCode: input.itemCode,
      quantity: input.quantity,
      notes: input.notes,
      isOverAllocation: input.isOverAllocation === true,
      overAllocationAcknowledgedBy: input.isOverAllocation ? input.overAllocationAcknowledgedBy ?? actorId : null,
      overAllocationAcknowledgedAt: input.isOverAllocation ? new Date() : null,
      createdBy: actorId,
    },
  });
}

export async function closeWorkOrder(prisma: PrismaClient, workOrderId: string) {
  const wo = await prisma.workOrder.findUnique({ where: { id: workOrderId }, include: { todoItems: true } });
  if (!wo) throw new NotFoundError("WorkOrder");
  const openTodo = wo.todoItems.find((t) => t.status !== WorkOrderToDoStatus.COMPLETED && t.status !== WorkOrderToDoStatus.CANCELLED);
  if (openTodo) throw new ValidationError("All todo items must be COMPLETED or CANCELLED before closing the work order");

  return prisma.workOrder.update({ where: { id: workOrderId }, data: { status: "CLOSED" } });
}

export async function amendWorkOrder(
  prisma: PrismaClient,
  workOrderId: string,
  actorId: string,
  input: { amendmentType: string; reason: string; payload?: Record<string, unknown> },
) {
  if (!input.amendmentType?.trim()) throw new ValidationError("amendmentType is required");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");

  const wo = await prisma.workOrder.findUnique({ where: { id: workOrderId } });
  if (!wo) throw new NotFoundError("WorkOrder");
  if (wo.status !== "OPEN") throw new ValidationError("Work order can only be amended while OPEN");

  const amendment = await prisma.workOrderAmendmentEvent.create({
    data: {
      workOrderId,
      amendmentType: input.amendmentType.trim(),
      reason: input.reason.trim(),
      payload: input.payload !== undefined ? (input.payload as Prisma.InputJsonValue) : undefined,
      createdBy: actorId,
    },
  });

  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { todoItems: true, amendments: { orderBy: { createdAt: "desc" }, take: 20 } },
  });

  return { workOrder, amendment };
}


