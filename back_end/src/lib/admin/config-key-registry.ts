/**
 * ACIG §6.2.25 / §9 — typed validator + ownership registry for keyed configuration.
 *
 * - `owner` identifies which admin service is allowed to write the key. Keys owned by a
 *   domain-specific service must NOT be written through the generic ConfigurationService
 *   (`/api/admin/configuration/:key`); the dedicated surface is the correct path.
 * - `validate` is an optional shape check; it returns an error message or null.
 */

export type ConfigOwner =
  | "ConfigurationService"
  | "RoomInstanceService"
  | "RatePlanService"
  | "CommercialThresholdService"
  | "CancellationPolicyService"
  | "WorkflowConfigurationService"
  | "FinancialConfigurationService"
  | "OperationalScheduleService"
  | "OTAConfigurationService"
  | "AIAgentConfigService"
  | "CommunicationConfigService"
  | "PostStayAndGovernanceService";

/** Human-facing route hint shown when a domain-owned key is written via the generic path. */
const OWNER_SURFACE: Record<ConfigOwner, string | null> = {
  ConfigurationService: null,
  RoomInstanceService: "/api/admin/deficient-categories",
  RatePlanService: "/api/admin/rate-plans",
  CommercialThresholdService: "/api/admin/commercial-thresholds/*",
  CancellationPolicyService: "/api/admin/cancellation-policies",
  WorkflowConfigurationService: "/api/admin/workflow",
  FinancialConfigurationService: "/api/admin/financial",
  OperationalScheduleService: "/api/admin/operational",
  OTAConfigurationService: "/api/admin/ota-config/*",
  AIAgentConfigService: "/api/admin/ai-agent-config/*",
  CommunicationConfigService: "/api/admin/communication-config/*",
  PostStayAndGovernanceService: "/api/admin/post-stay/*",
};

export interface ConfigKeyMeta {
  owner: ConfigOwner;
  validate?: (value: unknown) => string | null;
}

// --- shared validators ----------------------------------------------------

const positiveInt = (value: unknown): string | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "must be a positive number";
  return null;
};
const nonNegativeInt = (value: unknown): string | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return "must be a non-negative number";
  return null;
};
const isObject = (value: unknown): string | null =>
  value && typeof value === "object" && !Array.isArray(value) ? null : "must be an object";
const isArray = (value: unknown): string | null => (Array.isArray(value) ? null : "must be an array");
const cronString = (value: unknown): string | null => {
  if (typeof value !== "string") return "must be a cron string";
  const parts = value.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return "must be a 5- or 6-field cron expression";
  return null;
};
const percentage = (value: unknown): string | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return "must be a percentage between 0 and 100";
  return null;
};

const own = (owner: ConfigOwner, validate?: ConfigKeyMeta["validate"]): ConfigKeyMeta => ({ owner, validate });

// --- registry -------------------------------------------------------------

export const CONFIG_KEY_REGISTRY: Record<string, ConfigKeyMeta> = {
  // Expiry / workflow — historically owned by WorkflowConfigurationService, but the /admin/workflow
  // page was deleted (it duplicated Timers-Workers) and the workflow router never exposed a
  // ConfigurationEntry write endpoint for these keys, so ownership left them un-editable. They now
  // flow through the generic /api/admin/configuration/:key endpoint that the Timers-Workers page
  // uses. Validators are preserved.
  // expiry.s1.defaultTtlSeconds accepts either a raw number (uniform TTL) OR
  // { DEFAULT: number, [perSource]: number } (per-source overrides), so no shape validator.
  "expiry.s1.defaultTtlSeconds": { owner: "ConfigurationService" },
  "expiry.s2.quotationValidityDays": { validate: positiveInt, owner: "ConfigurationService" },
  "expiry.s2.speculativeHoldTtlSeconds": { validate: positiveInt, owner: "ConfigurationService" },
  "expiry.s3.committedHoldTtlSeconds": { validate: positiveInt, owner: "ConfigurationService" },
  "expiry.defaults": { validate: isObject, owner: "ConfigurationService" },
  "ownership.assignmentRules": { validate: isArray, owner: "ConfigurationService" },
  "billingModel.availablePerSource": { validate: isObject, owner: "ConfigurationService" },

  // Commercial thresholds (CommercialThresholdService)
  "discount.fom.maxPercentage": own("CommercialThresholdService", percentage),
  "discount.gm.maxPercentage": own("CommercialThresholdService", percentage),
  "creditCeiling.clientTier.thresholds": own("CommercialThresholdService", isObject),
  "creditCeiling.proximityThresholds": own("CommercialThresholdService", isObject),
  "foc.configuration": own("CommercialThresholdService"),
  "overbooking.maxAllowedRooms": own("CommercialThresholdService", nonNegativeInt),
  "confirmation.authorityThresholds": own("CommercialThresholdService", isObject),
  "speculativeHold.placementThresholds": own("CommercialThresholdService", isObject),
  "writeOff.authority.thresholds": own("CommercialThresholdService", isObject),

  // Rate plans (RatePlanService)
  "availability.walkIn.ratePlanId": own("RatePlanService"),

  // Cancellation (CancellationPolicyService)
  "cancellation.policyTiers": own("CancellationPolicyService"),

  // Financial (FinancialConfigurationService)
  "advancePayment.thresholds": own("FinancialConfigurationService", isObject),
  "advancePayment.followUpWindowSeconds": own("FinancialConfigurationService", positiveInt),
  "advancePayment.escalationWindowSeconds": own("FinancialConfigurationService", positiveInt),
  "proformaInvoice.templates": own("FinancialConfigurationService", isObject),
  "damage.rateList": own("FinancialConfigurationService"),
  "payment.followUpIntervalDays": own("FinancialConfigurationService", positiveInt),
  "dispute.fomOverride.maxFrequency": own("FinancialConfigurationService", nonNegativeInt),
  "billing.salesTaxRate": own("FinancialConfigurationService"),
  "billing.serviceChargeRate": own("FinancialConfigurationService"),

  // Operational schedule (OperationalScheduleService)
  "nightAudit.scheduleTime": own("OperationalScheduleService", cronString),
  "nightAudit.expectedChargesRules": own("OperationalScheduleService"),
  "checkout.cutoffTime": own("OperationalScheduleService"),
  "room_assignment_priority_rules": own("OperationalScheduleService"),

  // OTA (OTAConfigurationService)
  "ota.sourceFlagConfig": own("OTAConfigurationService"),
  "ota.inbox.pollingIntervalSeconds": own("OTAConfigurationService", positiveInt),
  "ota.conflictTriggerRules": own("OTAConfigurationService"),
  "noShow.cutoffMinutes": own("OTAConfigurationService", nonNegativeInt),
  "noShow.penaltyStructure": own("OTAConfigurationService"),

  // AI agent (AIAgentConfigService)
  "ai.agentConfig": own("AIAgentConfigService", isObject),
  "processingLock.ttl.perChannel": own("AIAgentConfigService", isObject),
  "voiceNote.reviewSlaPerChannel": own("AIAgentConfigService"),
  "voiceNote.escalationRouting": own("AIAgentConfigService"),

  // Communication (CommunicationConfigService)
  "communication.channels": own("CommunicationConfigService", isObject),
  "acknowledgement.windowPerType": own("CommunicationConfigService", isObject),

  // Post-stay & governance (PostStayAndGovernanceService)
  "feedback.platformLinks": own("PostStayAndGovernanceService"),
  "government.submissionConfig": own("PostStayAndGovernanceService"),
  "commission.calculationBasis": own("PostStayAndGovernanceService"),
  "identity.documentTypes": own("PostStayAndGovernanceService", isArray),
  "identity.retentionPeriodDays": own("PostStayAndGovernanceService", isObject),

  // Deficient categories (RoomInstanceService)
  "deficientCondition.categories": own("RoomInstanceService", isArray),

  // Generic surfaces owned by ConfigurationService
  "stageDwell.thresholds": own("ConfigurationService", isObject),
  "deficientResolution.deadlineHours": own("ConfigurationService", positiveInt),
  "lostFound.retention.warningOffsetDays": own("ConfigurationService", nonNegativeInt),
  "availability.staleness.ttlSeconds": own("ConfigurationService", positiveInt),
  "availability.bookablePhysicalStates": own("ConfigurationService", isArray),
  "availability.shadowInventory.visibilityRules": own("ConfigurationService"),
  "paymentMilestone.scheduleTemplates": own("ConfigurationService"),
  "paymentMilestone.warningOffsetDays": own("ConfigurationService", nonNegativeInt),
  "ai.confidenceThreshold.autoApprove": own("ConfigurationService"),
  "ai.correctionLog.maximumSize": own("ConfigurationService", positiveInt),
};

export function getConfigKeyMeta(configKey: string): ConfigKeyMeta | undefined {
  return CONFIG_KEY_REGISTRY[configKey];
}

export function ownerSurfaceHint(owner: ConfigOwner): string | null {
  return OWNER_SURFACE[owner];
}
