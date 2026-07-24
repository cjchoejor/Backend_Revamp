import { z } from "zod";

export const setConfigurationRequestSchema = z.object({
  configValue: z.unknown(),
  notes: z.string().optional().nullable(),
});

// Username: [a-z0-9._-]{3,32}, folded to lowercase on write. Explicit charset so we don't have
// to reason about Unicode edge cases at the login boundary.
const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._-]+$/i, "username must be 3–32 chars, letters/digits/./_/- only");

// PIN: exactly 4 digits. Business rule set with the user.
const pinSchema = z.string().regex(/^\d{4}$/u, "pin must be exactly 4 digits");

export const createStaffRequestSchema = z.object({
  fullName: z.string().min(1),
  username: usernameSchema,
  email: z.string().email().optional().nullable(),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]),
  role: z.string().min(1),
  // New canonical link to Role.id — readable ID like ROL-YYYYMMDD-NNNN.
  roleId: z.string().min(1).optional(),
  pin: pinSchema,
  idleThresholdSeconds: z.coerce.number().int().positive().optional(),
  hardLogoutThresholdSeconds: z.coerce.number().int().positive().optional(),
});

export const updateStaffRequestSchema = z.object({
  fullName: z.string().min(1).optional(),
  username: usernameSchema.optional(),
  email: z.string().email().optional().nullable(),
  actorLevel: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  role: z.string().min(1).optional(),
  roleId: z.string().min(1).optional().nullable(),
  idleThresholdSeconds: z.coerce.number().int().positive().optional(),
  hardLogoutThresholdSeconds: z.coerce.number().int().positive().optional(),
});

export const resetStaffPinRequestSchema = z.object({
  pin: pinSchema,
});

// Hard delete requires an explicit confirmation string so it can't happen by accident from a
// misfired click. Admin UI sends { confirm: "PURGE" }.
export const purgeStaffRequestSchema = z.object({
  confirm: z.literal("PURGE"),
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

export const markRoomDeficientRequestSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  resolutionDeadline: z.string().optional().nullable(),
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
  standardCapacity: z.coerce.number().int().min(1).optional(),
  maxCapacity: z.coerce.number().int().min(1).optional(),
  maxChildren: z.coerce.number().int().min(0).optional(),
  requiredAccompanyingAdults: z.coerce.number().int().min(0).optional(),
  maxExtraBeds: z.coerce.number().int().min(0).optional(),
});

export const updateRoomTypeRequestSchema = z.object({
  name: z.string().min(1).optional(),
  standardCapacity: z.coerce.number().int().min(1).optional(),
  maxCapacity: z.coerce.number().int().min(1).optional(),
  maxChildren: z.coerce.number().int().min(0).optional(),
  requiredAccompanyingAdults: z.coerce.number().int().min(0).optional(),
  maxExtraBeds: z.coerce.number().int().min(0).optional(),
});

export const createRoomRequestSchema = z.object({
  roomNumber: z.string().min(1),
  roomTypeId: z.string().min(1),
  floorNumber: z.coerce.number().int().optional().nullable(),
  capacity: z.coerce.number().int().positive().optional(),
  isShadowInventory: z.boolean().optional(),
});

export const updateRoomRequestSchema = z.object({
  roomNumber: z.string().min(1).optional(),
  roomTypeId: z.string().min(1).optional(),
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
  // ACIG §2.1A.7 typed columns.
  stageRoute: z.array(z.string()).default([]),
  autoFulfilmentConditions: z
    .array(z.object({ stage: z.string(), condition: z.string() }))
    .default([]),
  featureDependencies: z.array(z.string()).default([]),
});

export const savePolicyRequestSchema = z.object({
  policyId: z.string().min(1),
  policyClass: z.string().min(1),
  policyDefinition: z.unknown(),
});

export const sendTestEmailRequestSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** Optional Entry ID to thread under. If omitted, no threading anchor is used. */
  threadEntryId: z.string().optional(),
  /** Optional readable ID (e.g. "ENT-0042") that becomes the subject prefix for threading. */
  threadReadableId: z.string().optional(),
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

// --- Generic keyed-config payloads ---------------------------------------

export const valueOnlyRequestSchema = z.object({
  value: z.unknown(),
});

// --- Rate plans (ACIG §6.2.8) --------------------------------------------

const ratePlanType = z.enum(["INDIVIDUAL", "PROMOTIONAL", "TIER", "CHANNEL", "RACK"]);

export const createRatePlanRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  roomTypeId: z.string().optional().nullable(),
  type: ratePlanType.optional(),
  baseRate: z.coerce.number().nonnegative(),
  currency: z.string().min(1).optional(),
  msr: z.coerce.number().nonnegative().optional().nullable(),
  overrideMargin: z.coerce.number().optional().nullable(),
});

export const updateRatePlanRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  roomTypeId: z.string().optional().nullable(),
  type: ratePlanType.optional(),
  baseRate: z.coerce.number().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  msr: z.coerce.number().nonnegative().optional().nullable(),
  overrideMargin: z.coerce.number().optional().nullable(),
});

export const setWalkInRatePlanRequestSchema = z.object({
  ratePlanId: z.string().min(1),
});

// --- Seasons (ACIG §6.2.9) -----------------------------------------------

export const createSeasonRequestSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  rateMultiplier: z.coerce.number().positive().optional().nullable(),
  priority: z.coerce.number().int().optional(),
});

export const updateSeasonRequestSchema = z.object({
  name: z.string().min(1).optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().min(1).optional(),
  rateMultiplier: z.coerce.number().positive().optional().nullable(),
  priority: z.coerce.number().int().optional(),
});

// --- Packages (ACIG §6.2.10) ---------------------------------------------

export const createPackageRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  inclusions: z.unknown(),
  priceAdjustment: z.coerce.number().optional().nullable(),
  currency: z.string().min(1).optional(),
});

export const updatePackageRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  inclusions: z.unknown().optional(),
  priceAdjustment: z.coerce.number().optional().nullable(),
  currency: z.string().min(1).optional(),
});

// --- Cancellation policies (ACIG §6.2.12) --------------------------------

export const createCancellationPolicyRequestSchema = z.object({
  name: z.string().min(1),
  penaltyTiers: z.array(
    z.object({
      daysBeforeArrival: z.coerce.number().int().nonnegative(),
      penaltyPercentage: z.coerce.number().min(0).max(100),
    }),
  ),
  noShowTreatment: z.string().min(1),
});

export const updateCancellationPolicyRequestSchema = z.object({
  name: z.string().min(1).optional(),
  penaltyTiers: z
    .array(
      z.object({
        daysBeforeArrival: z.coerce.number().int().nonnegative(),
        penaltyPercentage: z.coerce.number().min(0).max(100),
      }),
    )
    .optional(),
  noShowTreatment: z.string().min(1).optional(),
});

// --- Commercial thresholds (ACIG §6.2.11) --------------------------------

export const setDiscountThresholdsRequestSchema = z.object({
  fomMaxPercentage: z.coerce.number().min(0).max(100),
  gmMaxPercentage: z.coerce.number().min(0).max(100),
});

export const setCreditCeilingThresholdsRequestSchema = z.object({
  clientTierThresholds: z.unknown(),
  proximityThresholds: z.unknown(),
});

export const setOverbookingLimitsRequestSchema = z.object({
  maxAllowedRooms: z.coerce.number().int().nonnegative(),
});

// --- OTA config (ACIG §6.2.23) -------------------------------------------

export const setPollingIntervalRequestSchema = z.object({
  seconds: z.coerce.number().int().positive(),
});

export const setNoShowCutoffRequestSchema = z.object({
  minutes: z.coerce.number().int().nonnegative(),
});

// --- AI agent config (ACIG §6.2.24) --------------------------------------

export const updateAIAgentConfigRequestSchema = z.record(z.unknown());

export const setProcessingLockTTLsRequestSchema = z.record(z.coerce.number().int().positive());

// --- Communication channels (ACIG §6.2.16) -------------------------------

export const updateChannelRequestSchema = z.record(z.unknown());

// --- Post-stay & governance (ACIG §6.2.22) -------------------------------

export const createFeedbackTemplateRequestSchema = z.object({
  templateKey: z.string().min(1),
  title: z.string().min(1),
  questions: z.unknown(),
});

export const updateFeedbackTemplateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  questions: z.unknown().optional(),
  isActive: z.boolean().optional(),
});

export const setCommissionRateRequestSchema = z.object({
  rate: z.coerce.number().min(0).max(1),
  effectiveFrom: z.string().optional().nullable(),
});
