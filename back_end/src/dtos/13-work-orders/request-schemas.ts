import { WorkOrderToDoStatus } from "@prisma/client";
import { z } from "zod";

export const createWorkOrderRequestSchema = z.object({
  entryId: z.string().min(1),
});
export type CreateWorkOrderRequestDto = z.infer<typeof createWorkOrderRequestSchema>;

export const addWorkOrderTodoRequestSchema = z.object({
  title: z.string().min(1),
  dueAt: z.string().optional(),
});
export type AddWorkOrderTodoRequestDto = z.infer<typeof addWorkOrderTodoRequestSchema>;

export const updateWorkOrderTodoStatusRequestSchema = z.object({
  status: z.nativeEnum(WorkOrderToDoStatus),
  cancelReason: z.string().optional(),
});
export type UpdateWorkOrderTodoStatusRequestDto = z.infer<typeof updateWorkOrderTodoStatusRequestSchema>;

export const recordWorkOrderConsumptionRequestSchema = z.object({
  itemCode: z.string().min(1),
  quantity: z.coerce.number().int().refine((n) => n > 0, "quantity must be a positive integer"),
  notes: z.string().optional(),
  isOverAllocation: z.boolean().optional(),
  overAllocationAcknowledgedBy: z.string().optional(),
});
export type RecordWorkOrderConsumptionRequestDto = z.infer<typeof recordWorkOrderConsumptionRequestSchema>;

export const amendWorkOrderRequestSchema = z.object({
  amendmentType: z.string().min(1),
  reason: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type AmendWorkOrderRequestDto = z.infer<typeof amendWorkOrderRequestSchema>;
