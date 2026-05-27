import { z } from "zod";

export const setConfigurationRequestSchema = z.object({
  configValue: z.unknown(),
  notes: z.string().optional().nullable(),
});

export const createStaffRequestSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional().nullable(),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]),
  role: z.string().min(1),
  pin: z.string().min(4),
  idleThresholdSeconds: z.coerce.number().int().positive().optional(),
  hardLogoutThresholdSeconds: z.coerce.number().int().positive().optional(),
});

export const updateStaffRequestSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional().nullable(),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  role: z.string().min(1).optional(),
  idleThresholdSeconds: z.coerce.number().int().positive().optional(),
  hardLogoutThresholdSeconds: z.coerce.number().int().positive().optional(),
});

export const resetStaffPinRequestSchema = z.object({
  pin: z.string().min(4),
});

export const deficientCategoriesRequestSchema = z.object({
  configValue: z.array(
    z.object({
      code: z.string().min(1),
      label: z.string().min(1),
      isActive: z.boolean().optional(),
    }),
  ),
  notes: z.string().optional().nullable(),
});

export const adminEnqueueRequestSchema = z.object({
  jobName: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  startAfterMs: z.number().int().nonnegative().optional(),
});

// --- Identity & org (ACIG) ---------------------------------------------

export const updateHotelProfileRequestSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  hotelName: z.string().min(1).optional(),
  registeredAddress: z.string().min(1).optional(),
  tradingAddress: z.string().min(1).optional().nullable(),
  contactNumbers: z.unknown().optional(),
  primaryEmail: z.string().email().optional(),
  operatingHours: z.unknown().optional(),
  publicHolidaySchedule: z.unknown().optional(),
  timeZone: z.string().min(1).optional(),
  propertyCurrency: z.string().min(1).optional(),
});

export const createDepartmentRequestSchema = z.object({
  departmentCode: z.string().min(1),
  departmentName: z.string().min(1),
});

export const updateDepartmentRequestSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  departmentName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export const createRoleRequestSchema = z.object({
  roleCode: z.string().min(1),
  displayName: z.string().min(1),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]),
});

export const updateRoleRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  isActive: z.boolean().optional(),
});

export const setRolePermissionsRequestSchema = z.object({
  permissionIds: z.array(z.string().min(1)),
});

export const upsertRoleSessionConfigRequestSchema = z.object({
  idleLockTimeoutSeconds: z.coerce.number().int().positive(),
  hardLogoutTimeoutSeconds: z.coerce.number().int().positive(),
  manualLockAvailable: z.boolean().optional(),
});

// --- Inventory ---------------------------------------------------------

export const createRoomTypeRequestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});

export const updateRoomTypeRequestSchema = z.object({
  name: z.string().min(1).optional(),
});

export const createRoomRequestSchema = z.object({
  roomNumber: z.string().min(1),
  roomTypeId: z.string().min(1),
  floorNumber: z.coerce.number().int().optional().nullable(),
  capacity: z.coerce.number().int().positive().optional(),
  isShadowInventory: z.boolean().optional(),
});

export const updateRoomRequestSchema = z.object({
  floorNumber: z.coerce.number().int().optional().nullable(),
  capacity: z.coerce.number().int().positive().optional(),
  isShadowInventory: z.boolean().optional(),
  isBlocked: z.boolean().optional(),
  blockedReason: z.string().optional().nullable(),
});

export const createSpaceRequestSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  spaceType: z.string().optional(),
  capacity: z.coerce.number().int().nonnegative().optional(),
  defaultCapacity: z.coerce.number().int().nonnegative().optional(),
});

export const updateSpaceRequestSchema = z.object({
  name: z.string().min(1).optional(),
  spaceType: z.string().optional(),
  capacity: z.coerce.number().int().nonnegative().optional(),
  isAvailable: z.boolean().optional(),
});

// --- Commercial / workflow / templates -----------------------------------

export const setCommercialConfigRequestSchema = z.object({
  configValue: z.unknown(),
  notes: z.string().optional().nullable(),
});

export const saveModeRequestSchema = z.object({
  id: z.string().optional(),
  modeKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional().nullable(),
  isPredefined: z.boolean().optional(),
  config: z.unknown(),
});

export const savePolicyRequestSchema = z.object({
  policyId: z.string().min(1),
  policyClass: z.string().min(1),
  policyDefinition: z.unknown(),
});

export const createCommunicationTemplateRequestSchema = z.object({
  templateKey: z.string().min(1),
  channel: z.string().min(1),
  templateType: z.string().min(1),
  bodyTemplate: z.string().min(1),
  subjectTemplate: z.string().optional().nullable(),
  stage: z.string().optional().nullable(),
});

export const updateCommunicationTemplateRequestSchema = z.object({
  channel: z.string().min(1).optional(),
  templateType: z.string().min(1).optional(),
  bodyTemplate: z.string().min(1).optional(),
  subjectTemplate: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const saveHandoffTemplateRequestSchema = z.object({
  handoffType: z.enum(["H1", "H2", "H3", "H4"]),
  checklistItems: z.unknown(),
});

export const createInvoiceTemplateRequestSchema = z.object({
  templateKey: z.string().min(1),
  invoiceType: z.enum(["PROFORMA", "FINAL"]),
  title: z.string().min(1),
  bodyTemplate: z.string().min(1),
});

export const updateInvoiceTemplateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  bodyTemplate: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export const createWorkOrderTemplateRequestSchema = z.object({
  templateKey: z.string().min(1),
  title: z.string().min(1),
  todoItems: z.unknown(),
  useType: z.string().optional().nullable(),
});

export const updateWorkOrderTemplateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  todoItems: z.unknown().optional(),
  isActive: z.boolean().optional(),
});

export const saveVipRoutingRequestSchema = z.object({
  vipTier: z.string().min(1),
  notifyRoles: z.unknown(),
  notifyActorIds: z.unknown(),
  isActive: z.boolean().optional(),
});
