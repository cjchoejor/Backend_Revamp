/**
 * Where each setting is read from and saved to (2026-11-02). The backend gives each group of settings
 * its own route and refuses a key on the wrong one, so a page only says which settings it shows and
 * this finds the way to them.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  getAcknowledgementWindow,
  getAiAgentConfig,
  getCancellationCharges,
  getCommercialConfig,
  getConfiguration,
  getDeficientCategories,
  getFinancialConfig,
  getOperationalConfig,
  getOtaConfig,
  getPostStayValue,
  getProcessingLockTtls,
  listCommunicationChannels,
  listPolicies,
  savePolicy,
  setAcknowledgementWindow,
  setCancellationCharges,
  setCommercialConfig,
  setConfiguration,
  setDeficientCategories,
  setFinancialConfig,
  setOperationalConfig,
  setOtaConfigValue,
  setOtaNoShowCutoff,
  setOtaPollingInterval,
  setPostStayValue,
  setProcessingLockTtls,
  updateAiAgentConfig,
  updateCommunicationChannel,
} from "@/lib/api/admin";
import { asRec } from "@/lib/admin/setting-fields";
import { getPolicyDef } from "@/lib/admin/setting-forms";
import type { Session } from "@/types/session";

export type SettingLoad = { value: unknown; isNew?: boolean; warning?: string };

export type SettingRoute = {
  load: (qc: QueryClient) => Promise<SettingLoad>;
  save: (value: unknown, note: string | null) => Promise<unknown>;
  /** Other reads this save makes stale. */
  invalidates?: unknown[][];
};

const FINANCIAL = new Set([
  "billing.salesTaxRate",
  "billing.serviceChargeRate",
  "advancePayment.thresholds",
  "advancePayment.followUpWindowSeconds",
  "advancePayment.escalationWindowSeconds",
  "payment.followUp.intervals",
  "payment.followUp.ttlDays",
  "invoice.templates",
  "invoice.templates.final",
  "invoice.templates.proforma",
  "proformaInvoice.templates",
  "damage.rateList",
  "dispute.sla",
  "fomOverride.frequency",
]);

const OPERATIONAL = new Set([
  "nightAudit.scheduleTime",
  "nightAudit.schedule",
  "nightAudit.expectedChargesRules",
  "nightAudit.expectedDailyFAndBCharge",
  "checkout.cutoffTime",
  "checkIn.standardTime",
  "roomAssignment.priorityRules",
  "housekeeping.sla.windowMinutes",
  "inspection.postCheckout.windowHours",
  "room.readiness.slaWindow",
  "noShow.cutoffWindowMinutes",
]);

const COMMERCIAL = new Set([
  "discount.fom.maxPercentage",
  "discount.gm.maxPercentage",
  "creditCeiling.clientTier.thresholds",
  "creditCeiling.proximityThresholds",
  "foc.configuration",
  "overbooking.maxAllowedRooms",
  "confirmation.authorityThresholds",
  "speculativeHold.placementThresholds",
  "writeOff.authority.thresholds",
]);

const POST_STAY: Record<string, string> = {
  "feedback.platformLinks": "platform-links",
  "government.submissionConfig": "government-portal",
  "identity.documentTypes": "identity-document-types",
  "identity.retentionPeriodDays": "identity-retention",
};

const OTA_VALUE: Record<string, string> = {
  "ota.sourceFlagConfig": "source-flags",
  "ota.conflictTriggerRules": "conflict-rules",
  "noShow.penaltyStructure": "no-show-penalty",
};

const policiesQuery = (session: Session, qc: QueryClient) =>
  qc.fetchQuery({ queryKey: ["admin", "policies"], queryFn: () => listPolicies(session), staleTime: 5_000 });

export function routeFor(session: Session, key: string): SettingRoute {
  const policy = getPolicyDef(key);
  if (policy) {
    return {
      load: async (qc) => {
        const { items } = await policiesQuery(session, qc);
        const row = items.find((p) => p.isActive && p.policyId === key);
        if (row) return { value: row.policyDefinition };
        return { value: { enabled: true, description: policy.about, ...policy.defaults }, isNew: true };
      },
      // Whatever else the rule holds, its description included, goes back as it came.
      save: (value) => savePolicy(session, { policyId: key, policyClass: policy.policyClass, policyDefinition: value }),
      invalidates: [["admin", "policies"]],
    };
  }

  if (FINANCIAL.has(key)) {
    return {
      load: async () => ({ value: (await getFinancialConfig(session, key)).configValue }),
      save: (configValue, notes) => setFinancialConfig(session, key, { configValue, notes }),
    };
  }
  if (OPERATIONAL.has(key)) {
    return {
      load: async () => ({ value: (await getOperationalConfig(session, key)).configValue }),
      save: (configValue, notes) => setOperationalConfig(session, key, { configValue, notes }),
    };
  }
  if (COMMERCIAL.has(key)) {
    return {
      load: async () => ({ value: (await getCommercialConfig(session, key)).configValue }),
      save: (configValue, notes) => setCommercialConfig(session, key, { configValue, notes }),
    };
  }
  if (POST_STAY[key]) {
    return {
      load: async () => ({ value: (await getPostStayValue(session, POST_STAY[key])).value ?? undefined }),
      save: (value) => setPostStayValue(session, POST_STAY[key], value),
    };
  }
  if (OTA_VALUE[key]) {
    return {
      load: async () => ({ value: (await getOtaConfig(session, OTA_VALUE[key])).value ?? undefined }),
      save: (value) => setOtaConfigValue(session, OTA_VALUE[key], value),
    };
  }

  switch (key) {
    case "ota.inbox.pollingIntervalSeconds":
      return {
        load: async () => ({ value: (await getOtaConfig(session, "polling-interval")).seconds ?? undefined }),
        save: (v) => setOtaPollingInterval(session, Number(v)),
      };
    case "noShow.cutoffMinutes":
      return {
        load: async () => ({ value: (await getOtaConfig(session, "no-show-cutoff")).minutes ?? undefined }),
        save: (v) => setOtaNoShowCutoff(session, Number(v)),
      };
    case "ai.agentConfig":
      return {
        load: async () => ({ value: (await getAiAgentConfig(session)).value ?? undefined }),
        save: (v) => updateAiAgentConfig(session, asRec(v)),
      };
    case "processingLock.ttl.perChannel":
      return {
        load: async () => ({ value: (await getProcessingLockTtls(session)).value ?? undefined }),
        save: (v) => setProcessingLockTtls(session, asRec(v) as Record<string, number>),
      };
    case "acknowledgement.windowPerType":
      return {
        load: async () => ({ value: (await getAcknowledgementWindow(session)).value ?? undefined }),
        save: (v) => setAcknowledgementWindow(session, v),
      };
    case "communication.channels":
      return {
        load: async () => ({ value: (await listCommunicationChannels(session)).channels }),
        // The backend saves one channel at a time; a key kept back stays as it is stored.
        save: async (v) => {
          for (const [id, channel] of Object.entries(asRec(v))) {
            await updateCommunicationChannel(session, id, asRec(channel));
          }
        },
      };
    case "cancellation.policyTiers":
      return {
        load: async () => {
          const r = await getCancellationCharges(session);
          return {
            value: r.value ?? undefined,
            warning: r.overwritten ? "These charges were overwritten when a cancellation policy was saved, so the desk is charging nothing from them. Enter them again." : undefined,
          };
        },
        save: (v, notes) => setCancellationCharges(session, v, notes),
      };
    case "deficientCondition.categories":
      return {
        load: async () => ({ value: (await getDeficientCategories(session)).configValue }),
        invalidates: [["admin", "deficient-categories"]],
        save: (v, notes) => setDeficientCategories(session, v as Array<{ code: string; label: string; isActive?: boolean }>, notes ?? undefined),
      };
    default:
      return {
        load: async () => ({ value: (await getConfiguration(session, key)).configValue }),
        save: (configValue, notes) => setConfiguration(session, key, { configValue, notes }),
      };
  }
}
