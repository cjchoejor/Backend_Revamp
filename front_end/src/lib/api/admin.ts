import type { Session } from "@/types/session";
import type { TraceEvent } from "@/lib/trace/humanize";
import { apiRequest } from "./client";

export type AdminOverview = {
  domains: number;
  services: number;
  configKeys: number;
  staffActive: number;
  staffL4: number;
  roomCount: number;
  readiness: { ready: boolean; summary: { ok: number; missing: number; warnings: number; total: number } };
};

export type ConfigurationActive = {
  id: string;
  configKey: string;
  configValue: unknown;
  effectiveFrom: string;
  effectiveTo: string | null;
  setBy: string;
  setAt: string;
  notes: string | null;
  isSystemDefault: boolean;
};

export type StaffUserAdmin = {
  id: string;
  fullName: string;
  email: string | null;
  actorLevel: string;
  role: string;
  idleThresholdSeconds: number;
  hardLogoutThresholdSeconds: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ReadinessReport = {
  ranAt: string;
  ready: boolean;
  summary: { ok: number; missing: number; warnings: number; total: number };
  checks: Array<{ id: string; label: string; status: "OK" | "MISSING" | "WARN"; detail?: string }>;
};

export type HotelProfileAdmin = {
  id: string;
  hotelName: string;
  registeredAddress: string;
  tradingAddress: string | null;
  contactNumbers: unknown;
  primaryEmail: string;
  operatingHours: unknown;
  publicHolidaySchedule: unknown;
  timeZone: string;
  propertyCurrency: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type DepartmentAdmin = {
  id: string;
  departmentCode: string;
  departmentName: string;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type RolePermissionMappingAdmin = {
  id: string;
  roleId: string;
  permissionId: string;
  isAllowed: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type RoleSessionConfigAdmin = {
  id: string;
  roleId: string;
  idleLockTimeoutSeconds: number;
  hardLogoutTimeoutSeconds: number;
  manualLockAvailable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type RoleAdmin = {
  id: string;
  roleCode: string;
  displayName: string;
  actorLevel: "L1" | "L2" | "L3" | "L4";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  permissions: RolePermissionMappingAdmin[];
  sessionCfg: RoleSessionConfigAdmin | null;
};

export async function getAdminOverview(session: Session) {
  return apiRequest<AdminOverview>("/api/admin/overview", { session });
}

export async function listConfigurationKeys(session: Session) {
  return apiRequest<{ keys: string[] }>("/api/admin/configuration/keys", { session });
}

export async function getConfiguration(session: Session, configKey: string) {
  return apiRequest<ConfigurationActive>(`/api/admin/configuration/${encodeURIComponent(configKey)}`, { session });
}

export async function setConfiguration(
  session: Session,
  configKey: string,
  body: { configValue: unknown; notes?: string | null },
) {
  return apiRequest(`/api/admin/configuration/${encodeURIComponent(configKey)}`, {
    method: "PATCH",
    session,
    body,
  });
}

export async function listStaff(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: StaffUserAdmin[]; count: number }>(`/api/admin/staff${q}`, { session });
}

export async function createStaff(
  session: Session,
  body: {
    fullName: string;
    email?: string | null;
    actorLevel: "L1" | "L2" | "L3" | "L4";
    role: string;
    pin: string;
    idleThresholdSeconds?: number;
    hardLogoutThresholdSeconds?: number;
  },
) {
  return apiRequest<StaffUserAdmin>("/api/admin/staff", { method: "POST", session, body });
}

export async function updateStaff(
  session: Session,
  id: string,
  body: Partial<{
    fullName: string;
    email: string | null;
    actorLevel: "L1" | "L2" | "L3" | "L4";
    role: string;
    idleThresholdSeconds: number;
    hardLogoutThresholdSeconds: number;
  }>,
) {
  return apiRequest<StaffUserAdmin>(`/api/admin/staff/${id}`, { method: "PATCH", session, body });
}

export async function resetStaffPin(session: Session, id: string, pin: string) {
  return apiRequest(`/api/admin/staff/${id}/reset-pin`, { method: "POST", session, body: { pin } });
}

export async function deactivateStaff(session: Session, id: string) {
  return apiRequest(`/api/admin/staff/${id}/deactivate`, { method: "POST", session });
}

export async function getReadiness(session: Session) {
  return apiRequest<ReadinessReport>("/api/admin/readiness", { session });
}

export async function runReadiness(session: Session) {
  return apiRequest<ReadinessReport>("/api/admin/readiness/run", { method: "POST", session });
}

export async function getHotelProfile(session: Session) {
  return apiRequest<HotelProfileAdmin>("/api/admin/hotel-profile", { session });
}

export async function updateHotelProfile(
  session: Session,
  body: Partial<Omit<HotelProfileAdmin, "id" | "createdAt" | "updatedAt" | "createdBy">> & { expectedVersion?: number },
) {
  return apiRequest<HotelProfileAdmin>("/api/admin/hotel-profile", { method: "PATCH", session, body });
}

export async function listDepartments(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: DepartmentAdmin[]; count: number }>(`/api/admin/departments${q}`, { session });
}

export async function createDepartment(session: Session, body: { departmentCode: string; departmentName: string }) {
  return apiRequest<DepartmentAdmin>("/api/admin/departments", { method: "POST", session, body });
}

export async function updateDepartment(
  session: Session,
  id: string,
  body: Partial<{ expectedVersion: number; departmentName: string; isActive: boolean }>,
) {
  return apiRequest<DepartmentAdmin>(`/api/admin/departments/${id}`, { method: "PATCH", session, body });
}

export async function listRoles(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: RoleAdmin[]; count: number }>(`/api/admin/roles${q}`, { session });
}

export async function createRole(session: Session, body: { roleCode: string; displayName: string; actorLevel: RoleAdmin["actorLevel"] }) {
  return apiRequest<RoleAdmin>("/api/admin/roles", { method: "POST", session, body });
}

export async function updateRole(session: Session, id: string, body: Partial<{ displayName: string; actorLevel: RoleAdmin["actorLevel"]; isActive: boolean }>) {
  return apiRequest<RoleAdmin>(`/api/admin/roles/${id}`, { method: "PATCH", session, body });
}

export async function deleteRole(session: Session, id: string) {
  return apiRequest<{ id: string; deleted: boolean }>(`/api/admin/roles/${id}`, { method: "DELETE", session });
}

export async function setRolePermissions(session: Session, id: string, permissionIds: string[]) {
  return apiRequest<RoleAdmin>(`/api/admin/roles/${id}/permissions`, { method: "PUT", session, body: { permissionIds } });
}

export async function upsertRoleSessionConfig(
  session: Session,
  id: string,
  body: { idleLockTimeoutSeconds: number; hardLogoutTimeoutSeconds: number; manualLockAvailable?: boolean },
) {
  return apiRequest<RoleAdmin>(`/api/admin/roles/${id}/session-config`, { method: "PUT", session, body });
}

export async function listAdminRooms(session: Session) {
  return apiRequest<{
    items: Array<{
      id: string;
      roomNumber: string;
      floorNumber: number | null;
      capacity: number;
      currentClaimState: string;
      physicalState: string;
      isDeficient: boolean;
      isBlocked: boolean;
      roomType: { id: string; code: string; name: string };
    }>;
    count: number;
  }>("/api/admin/rooms", { session });
}

export async function deactivateAdminRoom(session: Session, id: string, blockedReason?: string) {
  return apiRequest(`/api/admin/rooms/${id}/deactivate`, { method: "POST", session, body: blockedReason ? { blockedReason } : {} });
}

export async function deleteAdminRoom(session: Session, id: string) {
  return apiRequest<{ id: string; deleted: boolean }>(`/api/admin/rooms/${id}`, { method: "DELETE", session });
}

export async function markRoomDeficient(
  session: Session,
  roomId: string,
  body: { category: string; description: string; resolutionDeadline?: string | null },
) {
  return apiRequest(`/api/admin/rooms/${roomId}/deficient-conditions`, { method: "POST", session, body });
}

export async function resolveRoomDeficient(session: Session, roomId: string, resolutionNotes?: string) {
  return apiRequest(`/api/admin/rooms/${roomId}/resolve-deficient`, {
    method: "POST",
    session,
    body: { resolutionNotes: resolutionNotes ?? null },
  });
}

export async function reactivateAdminRoom(session: Session, roomId: string) {
  return apiRequest(`/api/admin/rooms/${roomId}/reactivate`, { method: "POST", session });
}

// --- Registry reactivate ------------------------------------------------

export async function reactivateRatePlan(session: Session, id: string) {
  return apiRequest<RatePlanAdmin>(`/api/admin/rate-plans/${id}/reactivate`, { method: "POST", session });
}

export async function reactivateSeason(session: Session, id: string) {
  return apiRequest<SeasonAdmin>(`/api/admin/seasons/${id}/reactivate`, { method: "POST", session });
}

export async function reactivatePackage(session: Session, id: string) {
  return apiRequest<PackageAdmin>(`/api/admin/packages/${id}/reactivate`, { method: "POST", session });
}

export async function reactivateCancellationPolicy(session: Session, id: string) {
  return apiRequest<CancellationPolicyAdmin>(`/api/admin/cancellation-policies/${id}/reactivate`, { method: "POST", session });
}

export async function reactivateVipRouting(session: Session, id: string) {
  return apiRequest(`/api/admin/vip-routing/${id}/reactivate`, { method: "POST", session });
}

export async function reactivateFeedbackTemplate(session: Session, id: string) {
  return apiRequest<FeedbackTemplateAdmin>(`/api/admin/post-stay/feedback-templates/${id}/reactivate`, { method: "POST", session });
}

// Templates (communication/invoice/work-order) — use existing PATCH with isActive:true.
export async function reactivateCommunicationTemplate(session: Session, id: string) {
  return updateCommunicationTemplate(session, id, { isActive: true });
}
export async function reactivateInvoiceTemplate(session: Session, id: string) {
  return updateInvoiceTemplate(session, id, { isActive: true });
}
export async function reactivateWorkOrderTemplate(session: Session, id: string) {
  return updateWorkOrderTemplate(session, id, { isActive: true });
}

export async function getDeficientCategories(session: Session) {
  return apiRequest<{ configKey: string; configValue: unknown; isSystemDefault: boolean }>(
    "/api/admin/deficient-condition-categories",
    { session },
  );
}

export async function setDeficientCategories(
  session: Session,
  configValue: Array<{ code: string; label: string; isActive?: boolean }>,
  notes?: string,
) {
  return apiRequest("/api/admin/deficient-condition-categories", {
    method: "PATCH",
    session,
    body: { configValue, notes },
  });
}

// --- Inventory (extended) ------------------------------------------------

export type RoomTypeAdmin = { id: string; code: string; name: string; _count?: { rooms: number } };

export async function listRoomTypes(session: Session) {
  return apiRequest<{ items: RoomTypeAdmin[]; count: number }>("/api/admin/room-types", { session });
}

export async function createRoomType(session: Session, body: { code: string; name: string }) {
  return apiRequest<RoomTypeAdmin>("/api/admin/room-types", { method: "POST", session, body });
}

export async function deleteRoomType(session: Session, id: string) {
  return apiRequest<{ id: string; deleted: boolean }>(`/api/admin/room-types/${id}`, { method: "DELETE", session });
}

export async function createAdminRoom(
  session: Session,
  body: { roomNumber: string; roomTypeId: string; floorNumber?: number | null; capacity?: number; isShadowInventory?: boolean },
) {
  return apiRequest("/api/admin/rooms", { method: "POST", session, body });
}

export async function updateAdminRoom(
  session: Session,
  id: string,
  body: {
    roomNumber?: string;
    roomTypeId?: string;
    floorNumber?: number | null;
    capacity?: number;
    isShadowInventory?: boolean;
    isBlocked?: boolean;
    blockedReason?: string | null;
  },
) {
  return apiRequest(`/api/admin/rooms/${id}`, { method: "PATCH", session, body });
}

export async function listSpaces(session: Session) {
  return apiRequest<{
    items: Array<{ id: string; code: string; name: string; spaceType: string; capacity: number; isAvailable: boolean }>;
    count: number;
  }>("/api/admin/spaces", { session });
}

export async function createSpace(session: Session, body: { code: string; name: string; spaceType?: string; capacity?: number }) {
  return apiRequest("/api/admin/spaces", { method: "POST", session, body });
}

export async function updateSpace(session: Session, id: string, body: Partial<{ name: string; capacity: number; isAvailable: boolean }>) {
  return apiRequest(`/api/admin/spaces/${id}`, { method: "PATCH", session, body });
}

export async function deleteSpace(session: Session, id: string) {
  return apiRequest<{ id: string; deleted: boolean }>(`/api/admin/spaces/${id}`, { method: "DELETE", session });
}

// --- Commercial ----------------------------------------------------------

export async function listCommercialConfigKeys(session: Session) {
  return apiRequest<{ keys: string[] }>("/api/admin/commercial/keys", { session });
}

export async function getCommercialConfig(session: Session, configKey: string) {
  return apiRequest<ConfigurationActive>(`/api/admin/commercial/${encodeURIComponent(configKey)}`, { session });
}

export async function setCommercialConfig(session: Session, configKey: string, body: { configValue: unknown; notes?: string | null }) {
  return apiRequest(`/api/admin/commercial/${encodeURIComponent(configKey)}`, { method: "PATCH", session, body });
}

// --- Workflow (modes & policies) ---------------------------------------

export type ModeAdmin = {
  id: string;
  modeKey: string;
  displayName: string;
  description: string | null;
  lifecycleState: string;
  isActive: boolean;
  isPredefined: boolean;
  stageRoute: string[];
  autoFulfilmentConditions: { stage: string; condition: string }[];
  featureDependencies: string[];
  version: number;
  effectiveFrom: string;
};

export type PolicyAdmin = {
  id: string;
  policyId: string;
  policyClass: string;
  policyDefinition: unknown;
  version: number;
  isActive: boolean;
};

export async function listModes(session: Session) {
  return apiRequest<{ items: ModeAdmin[]; count: number }>("/api/admin/modes", { session });
}

export async function saveMode(
  session: Session,
  body: {
    id?: string;
    modeKey: string;
    displayName: string;
    description?: string | null;
    isPredefined?: boolean;
    stageRoute: string[];
    autoFulfilmentConditions: { stage: string; condition: string }[];
    featureDependencies: string[];
  },
) {
  return apiRequest<ModeAdmin>("/api/admin/modes", { method: "POST", session, body });
}

export async function activateMode(session: Session, id: string) {
  return apiRequest<ModeAdmin>(`/api/admin/modes/${id}/activate`, { method: "POST", session });
}

export async function deactivateMode(session: Session, id: string) {
  return apiRequest<ModeAdmin>(`/api/admin/modes/${id}/deactivate`, { method: "POST", session });
}

export async function listPolicies(session: Session, activeOnly = false) {
  const q = activeOnly ? "?activeOnly=true" : "";
  return apiRequest<{ items: PolicyAdmin[]; count: number }>(`/api/admin/policies${q}`, { session });
}

export async function savePolicy(session: Session, body: { policyId: string; policyClass: string; policyDefinition: unknown }) {
  return apiRequest<PolicyAdmin>("/api/admin/policies", { method: "POST", session, body });
}

export async function deactivatePolicy(session: Session, policyId: string) {
  return apiRequest<PolicyAdmin>(`/api/admin/policies/${encodeURIComponent(policyId)}/deactivate`, { method: "POST", session });
}

// --- Templates -----------------------------------------------------------

export type CommunicationTemplateAdmin = {
  id: string;
  templateKey: string;
  channel: string;
  templateType: string;
  bodyTemplate: string;
  isActive: boolean;
};

export async function listCommunicationTemplates(session: Session) {
  return apiRequest<{ items: CommunicationTemplateAdmin[]; count: number }>("/api/admin/templates/communication", { session });
}

export async function listHandoffTemplates(session: Session) {
  return apiRequest<{
    items: Array<{ id: string; handoffType: string; version: number; checklistItems: unknown; isActive: boolean }>;
    count: number;
  }>("/api/admin/templates/handoff", { session });
}

export async function listInvoiceTemplates(session: Session) {
  return apiRequest<{
    items: Array<{ id: string; templateKey: string; invoiceType: string; title: string; isActive: boolean }>;
    count: number;
  }>("/api/admin/templates/invoice", { session });
}

export async function deactivateCommunicationTemplate(session: Session, id: string) {
  return apiRequest<CommunicationTemplateAdmin>(`/api/admin/templates/communication/${id}`, {
    method: "PATCH",
    session,
    body: { isActive: false },
  });
}

export async function deactivateInvoiceTemplate(session: Session, id: string) {
  return apiRequest(`/api/admin/templates/invoice/${id}`, { method: "PATCH", session, body: { isActive: false } });
}

// --- Template CRUD (ACIG §6.2.16–§6.2.20) -------------------------------

export async function createCommunicationTemplate(
  session: Session,
  body: { templateKey: string; channel: string; templateType: string; bodyTemplate: string; subjectTemplate?: string | null; stage?: string | null },
) {
  return apiRequest<CommunicationTemplateAdmin>("/api/admin/templates/communication", { method: "POST", session, body });
}

export async function updateCommunicationTemplate(
  session: Session,
  id: string,
  body: Partial<{ channel: string; templateType: string; bodyTemplate: string; subjectTemplate: string | null; isActive: boolean }>,
) {
  return apiRequest<CommunicationTemplateAdmin>(`/api/admin/templates/communication/${id}`, { method: "PATCH", session, body });
}

export async function saveHandoffTemplate(session: Session, body: { handoffType: "H1" | "H2" | "H3" | "H4"; checklistItems: unknown }) {
  return apiRequest("/api/admin/templates/handoff", { method: "POST", session, body });
}

export async function createInvoiceTemplate(
  session: Session,
  body: { templateKey: string; invoiceType: "PROFORMA" | "FINAL"; title: string; bodyTemplate: string },
) {
  return apiRequest("/api/admin/templates/invoice", { method: "POST", session, body });
}

export async function updateInvoiceTemplate(session: Session, id: string, body: Partial<{ title: string; bodyTemplate: string; isActive: boolean }>) {
  return apiRequest(`/api/admin/templates/invoice/${id}`, { method: "PATCH", session, body });
}

export type WorkOrderTemplateAdmin = { id: string; templateKey: string; title: string; useType: string | null; todoItems: unknown; isActive: boolean; version: number };

export async function listWorkOrderTemplates(session: Session) {
  return apiRequest<{ items: WorkOrderTemplateAdmin[]; count: number }>("/api/admin/templates/work-order", { session });
}

export async function createWorkOrderTemplate(
  session: Session,
  body: { templateKey: string; title: string; todoItems: unknown; useType?: string | null },
) {
  return apiRequest<WorkOrderTemplateAdmin>("/api/admin/templates/work-order", { method: "POST", session, body });
}

export async function updateWorkOrderTemplate(session: Session, id: string, body: Partial<{ title: string; todoItems: unknown; isActive: boolean }>) {
  return apiRequest<WorkOrderTemplateAdmin>(`/api/admin/templates/work-order/${id}`, { method: "PATCH", session, body });
}

export async function deactivateWorkOrderTemplate(session: Session, id: string) {
  return apiRequest(`/api/admin/templates/work-order/${id}`, { method: "PATCH", session, body: { isActive: false } });
}

// --- Financial & operational -------------------------------------------

export async function listFinancialConfigKeys(session: Session) {
  return apiRequest<{ keys: string[] }>("/api/admin/financial/keys", { session });
}

export async function getFinancialConfig(session: Session, configKey: string) {
  return apiRequest<ConfigurationActive>(`/api/admin/financial/${encodeURIComponent(configKey)}`, { session });
}

export async function setFinancialConfig(session: Session, configKey: string, body: { configValue: unknown; notes?: string | null }) {
  return apiRequest(`/api/admin/financial/${encodeURIComponent(configKey)}`, { method: "PATCH", session, body });
}

export async function listOperationalConfigKeys(session: Session) {
  return apiRequest<{ keys: string[] }>("/api/admin/operational/keys", { session });
}

export async function getOperationalConfig(session: Session, configKey: string) {
  return apiRequest<ConfigurationActive>(`/api/admin/operational/${encodeURIComponent(configKey)}`, { session });
}

export async function setOperationalConfig(session: Session, configKey: string, body: { configValue: unknown; notes?: string | null }) {
  return apiRequest(`/api/admin/operational/${encodeURIComponent(configKey)}`, { method: "PATCH", session, body });
}

export async function listVipRoutings(session: Session) {
  return apiRequest<{
    items: Array<{ id: string; vipTier: string; notifyRoles: unknown; notifyActorIds: unknown; isActive: boolean }>;
    count: number;
  }>("/api/admin/vip-routing", { session });
}

export async function saveVipRouting(
  session: Session,
  body: { vipTier: string; notifyRoles: unknown; notifyActorIds: unknown },
) {
  return apiRequest("/api/admin/vip-routing", { method: "POST", session, body });
}

export async function deactivateVipRouting(session: Session, id: string) {
  return apiRequest(`/api/admin/vip-routing/${id}/deactivate`, { method: "POST", session });
}

// --- Rate plans (ACIG §6.2.8) -------------------------------------------

export type RatePlanType = "INDIVIDUAL" | "PROMOTIONAL" | "TIER" | "CHANNEL" | "RACK";

export type RatePlanAdmin = {
  id: string;
  name: string;
  description: string | null;
  roomTypeId: string | null;
  type: RatePlanType;
  baseRate: string;
  currency: string;
  msr: string | null;
  overrideMargin: string | null;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type RatePlanInput = {
  name: string;
  description?: string | null;
  roomTypeId?: string | null;
  type?: RatePlanType;
  baseRate: number;
  currency?: string;
  msr?: number | null;
  overrideMargin?: number | null;
};

export async function listRatePlans(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: RatePlanAdmin[]; count: number }>(`/api/admin/rate-plans${q}`, { session });
}
export async function createRatePlan(session: Session, body: RatePlanInput) {
  return apiRequest<RatePlanAdmin>("/api/admin/rate-plans", { method: "POST", session, body });
}
export async function updateRatePlan(session: Session, id: string, body: Partial<RatePlanInput>) {
  return apiRequest<RatePlanAdmin>(`/api/admin/rate-plans/${id}`, { method: "PATCH", session, body });
}
export async function deactivateRatePlan(session: Session, id: string) {
  return apiRequest<RatePlanAdmin>(`/api/admin/rate-plans/${id}/deactivate`, { method: "POST", session });
}
export async function getWalkInRatePlan(session: Session) {
  return apiRequest<{ ratePlanId: string | null; ratePlan: RatePlanAdmin | null }>("/api/admin/rate-plans/walk-in", { session });
}
export async function setWalkInRatePlan(session: Session, ratePlanId: string) {
  return apiRequest("/api/admin/rate-plans/walk-in", { method: "PUT", session, body: { ratePlanId } });
}

// --- Seasons (ACIG §6.2.9) ----------------------------------------------

export type SeasonAdmin = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  rateMultiplier: string | null;
  priority: number;
  isActive: boolean;
  version: number;
};

export type SeasonInput = {
  name: string;
  startDate: string;
  endDate: string;
  rateMultiplier?: number | null;
  priority?: number;
};

export async function listSeasons(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: SeasonAdmin[]; count: number }>(`/api/admin/seasons${q}`, { session });
}
export async function createSeason(session: Session, body: SeasonInput) {
  return apiRequest<SeasonAdmin>("/api/admin/seasons", { method: "POST", session, body });
}
export async function updateSeason(session: Session, id: string, body: Partial<SeasonInput>) {
  return apiRequest<SeasonAdmin>(`/api/admin/seasons/${id}`, { method: "PATCH", session, body });
}
export async function deactivateSeason(session: Session, id: string) {
  return apiRequest<SeasonAdmin>(`/api/admin/seasons/${id}/deactivate`, { method: "POST", session });
}

// --- Packages (ACIG §6.2.10) --------------------------------------------

export type PackageAdmin = {
  id: string;
  name: string;
  description: string | null;
  inclusions: unknown;
  priceAdjustment: string | null;
  currency: string;
  isActive: boolean;
  version: number;
};

export type PackageInput = {
  name: string;
  description?: string | null;
  inclusions: unknown;
  priceAdjustment?: number | null;
  currency?: string;
};

export async function listPackages(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: PackageAdmin[]; count: number }>(`/api/admin/packages${q}`, { session });
}
export async function createPackage(session: Session, body: PackageInput) {
  return apiRequest<PackageAdmin>("/api/admin/packages", { method: "POST", session, body });
}
export async function updatePackage(session: Session, id: string, body: Partial<PackageInput>) {
  return apiRequest<PackageAdmin>(`/api/admin/packages/${id}`, { method: "PATCH", session, body });
}
export async function deactivatePackage(session: Session, id: string) {
  return apiRequest<PackageAdmin>(`/api/admin/packages/${id}/deactivate`, { method: "POST", session });
}

// --- Cancellation policies (ACIG §6.2.12) -------------------------------

export type PenaltyTier = { daysBeforeArrival: number; penaltyPercentage: number };
export type CancellationPolicyAdmin = {
  id: string;
  name: string;
  penaltyTiers: PenaltyTier[];
  noShowTreatment: string;
  isActive: boolean;
  version: number;
};

export async function listCancellationPolicies(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: CancellationPolicyAdmin[]; count: number }>(`/api/admin/cancellation-policies${q}`, { session });
}
export async function createCancellationPolicy(
  session: Session,
  body: { name: string; penaltyTiers: PenaltyTier[]; noShowTreatment: string },
) {
  return apiRequest<CancellationPolicyAdmin>("/api/admin/cancellation-policies", { method: "POST", session, body });
}
export async function updateCancellationPolicy(
  session: Session,
  id: string,
  body: Partial<{ name: string; penaltyTiers: PenaltyTier[]; noShowTreatment: string }>,
) {
  return apiRequest<CancellationPolicyAdmin>(`/api/admin/cancellation-policies/${id}`, { method: "PATCH", session, body });
}
export async function deactivateCancellationPolicy(session: Session, id: string) {
  return apiRequest<CancellationPolicyAdmin>(`/api/admin/cancellation-policies/${id}/deactivate`, { method: "POST", session });
}

// --- Commercial thresholds (ACIG §6.2.11) -------------------------------

export async function getDiscountThresholds(session: Session) {
  return apiRequest<{ fomMaxPercentage: unknown; gmMaxPercentage: unknown }>("/api/admin/commercial-thresholds/discount", { session });
}
export async function setDiscountThresholds(session: Session, body: { fomMaxPercentage: number; gmMaxPercentage: number }) {
  return apiRequest("/api/admin/commercial-thresholds/discount", { method: "PUT", session, body });
}
export async function getCreditCeilingThresholds(session: Session) {
  return apiRequest<{ clientTierThresholds: unknown; proximityThresholds: unknown }>("/api/admin/commercial-thresholds/credit-ceiling", { session });
}
export async function setCreditCeilingThresholds(session: Session, body: { clientTierThresholds: unknown; proximityThresholds: unknown }) {
  return apiRequest("/api/admin/commercial-thresholds/credit-ceiling", { method: "PUT", session, body });
}
export async function getOverbookingLimits(session: Session) {
  return apiRequest<{ maxAllowedRooms: unknown }>("/api/admin/commercial-thresholds/overbooking", { session });
}
export async function setOverbookingLimits(session: Session, maxAllowedRooms: number) {
  return apiRequest("/api/admin/commercial-thresholds/overbooking", { method: "PUT", session, body: { maxAllowedRooms } });
}

// --- OTA config (ACIG §6.2.23) ------------------------------------------

export async function getOtaConfig(session: Session, surface: string) {
  return apiRequest<Record<string, unknown>>(`/api/admin/ota-config/${surface}`, { session });
}
export async function setOtaConfigValue(session: Session, surface: string, value: unknown) {
  return apiRequest(`/api/admin/ota-config/${surface}`, { method: "PUT", session, body: { value } });
}
export async function setOtaPollingInterval(session: Session, seconds: number) {
  return apiRequest("/api/admin/ota-config/polling-interval", { method: "PUT", session, body: { seconds } });
}
export async function setOtaNoShowCutoff(session: Session, minutes: number) {
  return apiRequest("/api/admin/ota-config/no-show-cutoff", { method: "PUT", session, body: { minutes } });
}

// --- AI agent config (ACIG §6.2.24) -------------------------------------

export async function getAiAgentConfig(session: Session) {
  return apiRequest<{ value: unknown }>("/api/admin/ai-agent-config", { session });
}
export async function updateAiAgentConfig(session: Session, body: Record<string, unknown>) {
  return apiRequest("/api/admin/ai-agent-config", { method: "PUT", session, body });
}
export async function getProcessingLockTtls(session: Session) {
  return apiRequest<{ value: unknown }>("/api/admin/ai-agent-config/processing-lock-ttl", { session });
}
export async function setProcessingLockTtls(session: Session, body: Record<string, number>) {
  return apiRequest("/api/admin/ai-agent-config/processing-lock-ttl", { method: "PUT", session, body });
}

// --- Communication channels (ACIG §6.2.16) ------------------------------

export async function listCommunicationChannels(session: Session) {
  return apiRequest<{ channels: Record<string, unknown> }>("/api/admin/communication-config/channels", { session });
}
export async function updateCommunicationChannel(session: Session, channelId: string, body: Record<string, unknown>) {
  return apiRequest(`/api/admin/communication-config/channels/${encodeURIComponent(channelId)}`, { method: "PUT", session, body });
}
export async function getAcknowledgementWindow(session: Session) {
  return apiRequest<{ value: unknown }>("/api/admin/communication-config/acknowledgement-window", { session });
}
export async function setAcknowledgementWindow(session: Session, value: unknown) {
  return apiRequest("/api/admin/communication-config/acknowledgement-window", { method: "PUT", session, body: { value } });
}

// --- Post-stay & governance (ACIG §6.2.22) ------------------------------

export type FeedbackTemplateAdmin = { id: string; templateKey: string; title: string; questions: unknown; isActive: boolean; version: number };

export async function listFeedbackTemplates(session: Session, includeInactive = false) {
  const q = includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ items: FeedbackTemplateAdmin[]; count: number }>(`/api/admin/post-stay/feedback-templates${q}`, { session });
}
export async function createFeedbackTemplate(session: Session, body: { templateKey: string; title: string; questions: unknown }) {
  return apiRequest<FeedbackTemplateAdmin>("/api/admin/post-stay/feedback-templates", { method: "POST", session, body });
}
export async function deactivateFeedbackTemplate(session: Session, id: string) {
  return apiRequest(`/api/admin/post-stay/feedback-templates/${id}/deactivate`, { method: "POST", session });
}
export async function getPostStayValue(session: Session, surface: string) {
  return apiRequest<{ value: unknown }>(`/api/admin/post-stay/${surface}`, { session });
}
export async function setPostStayValue(session: Session, surface: string, value: unknown) {
  return apiRequest(`/api/admin/post-stay/${surface}`, { method: "PUT", session, body: { value } });
}

// --- Audit trail (read-only trace_events view) --------------------------

export type AuditEventFilters = {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  eventType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export async function queryAuditEvents(session: Session, filters: AuditEventFilters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    // datetime-local values are local wall-clock; convert to a UTC instant so the range matches intent.
    if ((k === "from" || k === "to") && typeof v === "string") {
      const d = new Date(v);
      q.set(k, Number.isNaN(d.getTime()) ? String(v) : d.toISOString());
      continue;
    }
    q.set(k, String(v));
  }
  const qs = q.toString();
  return apiRequest<{ items: TraceEvent[]; total: number; limit: number; offset: number }>(
    `/api/admin/audit-events${qs ? `?${qs}` : ""}`,
    { session },
  );
}

// ----- Email (Phase 1: test surface) -----

export type EmailVerifyResult = { ok: true } | { ok: false; error: string };
export type EmailSendResult =
  | { status: "sent"; messageId: string; redirected: boolean; intendedRecipient: string; actualRecipient: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string };

export async function verifyEmailTransport(session: Session) {
  return apiRequest<EmailVerifyResult>("/api/admin/email/verify", { session });
}

export async function sendTestEmail(
  session: Session,
  body: { to: string; subject: string; body: string; threadEntryId?: string; threadReadableId?: string },
) {
  return apiRequest<EmailSendResult>("/api/admin/email/test-send", {
    method: "POST",
    session,
    body,
  });
}

// ----- ID prefix admin (readable business IDs per entity) -----

export type IdPrefixEntry = {
  entity: string;
  currentPrefix: string;
  defaultPrefix: string;
  isOverridden: boolean;
};

export async function listIdPrefixAssignments(session: Session) {
  return apiRequest<{ assignments: IdPrefixEntry[] }>("/api/admin/id-prefixes", { session });
}

export async function setIdPrefix(session: Session, body: { entity: string; prefix: string; notes?: string }) {
  return apiRequest<{ assignments: IdPrefixEntry[] }>("/api/admin/id-prefixes", {
    method: "PUT",
    session,
    body,
  });
}

export async function resetIdPrefix(session: Session, body: { entity: string }) {
  return apiRequest<{ assignments: IdPrefixEntry[] }>("/api/admin/id-prefixes/reset", {
    method: "POST",
    session,
    body,
  });
}

// ----- EntityVersionSnapshot (version history for admin CRUD tables) -----

export type EntityVersionSnapshot = {
  id: string;
  version: number;
  rowJson: Record<string, unknown>;
  changedAt: string;
  changedBy: string;
  changeNote: string | null;
};

export async function listVersionSnapshots(
  session: Session,
  params: { entityType: string; entityId: string },
) {
  const qs = new URLSearchParams({ entityType: params.entityType, entityId: params.entityId });
  return apiRequest<{ snapshots: EntityVersionSnapshot[] }>(
    `/api/admin/version-snapshots?${qs.toString()}`,
    { session },
  );
}

export async function restoreVersionSnapshot(
  session: Session,
  body: { snapshotId: string; changeNote?: string },
) {
  return apiRequest<{ restored: unknown }>(`/api/admin/version-snapshots/restore`, {
    method: "POST",
    session,
    body,
  });
}

// ----- Travel agents (Phase B) -----

export type ContactMode = "PHONE" | "EMAIL" | "WHATSAPP" | "IN_PERSON" | "OTHER";
export type PartyType = "TRAVEL_AGENT" | "CORPORATE";
export type MealPlanType = "CP" | "MAP_LUNCH" | "MAP_DINNER" | "AP";

export type TravelAgentAdmin = {
  id: string;
  displayName: string;
  contactNumber: string | null;
  contactEmail: string | null;
  modeOfContact: ContactMode;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};

export type TravelAgentInput = {
  displayName: string;
  contactNumber?: string | null;
  contactEmail?: string | null;
  modeOfContact?: ContactMode | null;
  notes?: string | null;
  isActive?: boolean;
};

export async function listTravelAgents(session: Session, params?: { includeInactive?: boolean }) {
  const qs = params?.includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ agents: TravelAgentAdmin[] }>(`/api/admin/travel-agents${qs}`, { session });
}

export async function createTravelAgent(session: Session, body: TravelAgentInput) {
  return apiRequest<TravelAgentAdmin>(`/api/admin/travel-agents`, { method: "POST", session, body });
}

export async function updateTravelAgent(session: Session, id: string, body: Partial<TravelAgentInput>) {
  return apiRequest<TravelAgentAdmin>(`/api/admin/travel-agents/${id}`, { method: "PUT", session, body });
}

export async function deactivateTravelAgent(session: Session, id: string) {
  return apiRequest<TravelAgentAdmin>(`/api/admin/travel-agents/${id}/deactivate`, { method: "POST", session });
}

export async function reactivateTravelAgent(session: Session, id: string) {
  return apiRequest<TravelAgentAdmin>(`/api/admin/travel-agents/${id}/reactivate`, { method: "POST", session });
}

// ----- Corporate accounts (Phase B) -----

export type CorporateAccountAdmin = {
  id: string;
  displayName: string;
  contactNumber: string | null;
  contactEmail: string | null;
  modeOfContact: ContactMode;
  gstNumber: string | null;
  billingAddress: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};

export type CorporateAccountInput = {
  displayName: string;
  contactNumber?: string | null;
  contactEmail?: string | null;
  modeOfContact?: ContactMode | null;
  gstNumber?: string | null;
  billingAddress?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export async function listCorporateAccounts(session: Session, params?: { includeInactive?: boolean }) {
  const qs = params?.includeInactive ? "?includeInactive=true" : "";
  return apiRequest<{ accounts: CorporateAccountAdmin[] }>(`/api/admin/corporate-accounts${qs}`, { session });
}

export async function createCorporateAccount(session: Session, body: CorporateAccountInput) {
  return apiRequest<CorporateAccountAdmin>(`/api/admin/corporate-accounts`, { method: "POST", session, body });
}

export async function updateCorporateAccount(session: Session, id: string, body: Partial<CorporateAccountInput>) {
  return apiRequest<CorporateAccountAdmin>(`/api/admin/corporate-accounts/${id}`, { method: "PUT", session, body });
}

export async function deactivateCorporateAccount(session: Session, id: string) {
  return apiRequest<CorporateAccountAdmin>(`/api/admin/corporate-accounts/${id}/deactivate`, { method: "POST", session });
}

export async function reactivateCorporateAccount(session: Session, id: string) {
  return apiRequest<CorporateAccountAdmin>(`/api/admin/corporate-accounts/${id}/reactivate`, { method: "POST", session });
}

// ----- Rate cards (Phase B) -----

export type RateCardOverride = {
  id: string;
  rateCardId: string;
  roomTypeId: string;
  roomBaseRate: string;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  roomType?: { id: string; code: string; name: string };
};

export type RateCardAdmin = {
  id: string;
  partyType: PartyType;
  partyId: string;
  roomBaseRate: string;
  extraBedRate: string | null;
  cnbPercent: number | null;
  breakfastRate: string | null;
  lunchRate: string | null;
  dinnerRate: string | null;
  cpRate: string | null;
  mapLunchRate: string | null;
  mapDinnerRate: string | null;
  apRate: string | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  overrides: RateCardOverride[];
};

export type RateCardInput = {
  partyType: PartyType;
  partyId: string;
  roomBaseRate: number | string;
  extraBedRate?: number | string | null;
  cnbPercent?: number | null;
  breakfastRate?: number | string | null;
  lunchRate?: number | string | null;
  dinnerRate?: number | string | null;
  cpRate?: number | string | null;
  mapLunchRate?: number | string | null;
  mapDinnerRate?: number | string | null;
  apRate?: number | string | null;
  currency?: string;
  notes?: string | null;
};

export async function listRateCards(session: Session, partyType: PartyType, partyId: string) {
  const qs = new URLSearchParams({ partyType, partyId });
  return apiRequest<{ cards: RateCardAdmin[] }>(`/api/admin/rate-cards?${qs}`, { session });
}

export async function getActiveRateCard(session: Session, partyType: PartyType, partyId: string) {
  const qs = new URLSearchParams({ partyType, partyId });
  return apiRequest<{ active: RateCardAdmin | null }>(`/api/admin/rate-cards/active?${qs}`, { session });
}

export async function createRateCardVersion(session: Session, body: RateCardInput) {
  return apiRequest<RateCardAdmin>(`/api/admin/rate-cards`, { method: "POST", session, body });
}

export async function setRateCardOverride(
  session: Session,
  rateCardId: string,
  body: { roomTypeId: string; roomBaseRate: number | string; notes?: string | null },
) {
  return apiRequest<RateCardOverride>(`/api/admin/rate-cards/${rateCardId}/overrides`, {
    method: "PUT",
    session,
    body,
  });
}

export async function deleteRateCardOverride(session: Session, overrideId: string) {
  return apiRequest<{ ok: true }>(`/api/admin/rate-cards/overrides/${overrideId}`, {
    method: "DELETE",
    session,
  });
}

