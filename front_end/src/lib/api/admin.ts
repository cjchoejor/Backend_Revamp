import type { Session } from "@/types/session";
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
      currentClaimState: string;
      physicalState: string;
      isDeficient: boolean;
      isBlocked: boolean;
      roomType: { code: string; name: string };
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
  config: unknown;
  version: number;
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
  body: { id?: string; modeKey: string; displayName: string; description?: string | null; config: unknown },
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
