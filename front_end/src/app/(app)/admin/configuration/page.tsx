"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getConfiguration, listConfigurationKeys, setConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

/**
 * Per ACIG §6.2.25, the generic ConfigurationService surface only owns keys that don't have a
 * dedicated domain service. Domain-owned keys (discount.*, advancePayment.*, nightAudit.*, etc.)
 * are excluded here so operators are forced to edit them on their proper domain page.
 *
 * Source of truth for ownership: `back_end/src/lib/admin/config-key-registry.ts`.
 */
const ORPHANED_KEY_WHITELIST = new Set([
  "stageDwell.thresholds",
  "deficientResolution.deadlineHours",
  "lostFound.retention.warningOffsetDays",
  "availability.staleness.ttlSeconds",
  "availability.bookablePhysicalStates",
  "availability.shadowInventory.visibilityRules",
  "paymentMilestone.scheduleTemplates",
  "paymentMilestone.warningOffsetDays",
  "ai.confidenceThreshold.autoApprove",
  "ai.correctionLog.maximumSize",
  // CancellationPolicyService-owned but no dedicated UI surface today — surface here so it's
  // editable. /admin/cancellation-policies is a CRUD page for the registry table, not for the
  // default-fallback policy tiers config key.
  "cancellation.policyTiers",
]);

/** Domain-owned (or legacy) key prefixes that should never appear in the generic catalogue. */
const DOMAIN_OWNED_PREFIXES = [
  "discount.",
  "creditCeiling.",
  "foc.",
  "overbooking.",
  "confirmation.authority",
  "speculativeHold.placementThresholds",
  "writeOff.authority.thresholds",
  "cancellation.policyTiers",
  "advancePayment.",
  "proformaInvoice.",
  "damage.",
  "payment.followUp",
  "billing.",
  "invoice.templates",
  "dispute.",
  "fomOverride.",
  "nightAudit.",
  "checkout.",
  "roomAssignment.",
  "housekeeping.",
  "inspection.",
  "room.readiness",
  "noShow.",
  "ota.",
  "ota_email_poll",
  "ai.agentConfig",
  "processingLock.",
  "voiceNote.",
  "communication.",
  "acknowledgement.",
  "feedback.",
  "government.",
  "commission.",
  "identity.",
  "deficientCondition.categories",
  "availability.walkIn",
  "expiry.s",
  // Legacy (no longer read by operational code) — rate plans moved to the rate_plan_registry table.
  "pricing.ratePlans",
];

function isOrphaned(key: string): boolean {
  if (ORPHANED_KEY_WHITELIST.has(key)) return true;
  return !DOMAIN_OWNED_PREFIXES.some((p) => key.startsWith(p));
}

export default function AdminConfigurationPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");

  const keysQuery = useQuery({
    queryKey: ["admin", "config-keys"],
    queryFn: () => listConfigurationKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  // Restrict to orphaned keys per ACIG §6.2.25 — domain-owned keys must be edited on their
  // proper domain pages so the ownership check on the backend doesn't reject saves.
  const keys = (keysQuery.data?.keys ?? []).filter(isOrphaned);
  const filteredKeys = useMemo(() => {
    const q = selectedKey.trim().toLowerCase();
    if (!q || keys.includes(selectedKey)) return keys;
    return keys.filter((k) => k.toLowerCase().includes(q));
  }, [keys, selectedKey]);

  const activeQuery = useQuery({
    queryKey: ["admin", "config", selectedKey],
    queryFn: () => getConfiguration(session!, selectedKey),
    enabled: !!session && session.actorLevel === "L4" && !!selectedKey && keys.includes(selectedKey),
  });

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 09 · Generic & readiness</p>
        <h1 className="admin-display text-3xl">Configuration (orphaned keys)</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          The generic ConfigurationService surface per ACIG §6.2.25. Only keys with no dedicated
          domain service appear here. Domain-owned keys (discount, credit ceiling, advance payment,
          night audit, OTA, etc.) are surfaced on their proper domain page — edit them there.
          Saving creates a new version row and closes the prior active window.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[70vh] overflow-y-auto p-3">
          <input
            className="admin-input mb-2"
            placeholder="Filter keys…"
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
          />
          <ul className="space-y-0.5 text-xs font-mono">
            {filteredKeys.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  className="w-full truncate rounded px-2 py-1.5 text-left text-[var(--admin-ink-soft)] hover:bg-[var(--admin-brass-glow)] hover:text-[var(--admin-brass)]"
                  onClick={() => setSelectedKey(key)}
                >
                  {key}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="admin-panel space-y-4 p-5">
          {!selectedKey || !keys.includes(selectedKey) ? (
            <p className="admin-muted text-sm">Select a configuration key from the list.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-[var(--admin-brass)]">{selectedKey}</span>
                {activeQuery.data?.isSystemDefault && <span className="admin-tag">system default</span>}
              </div>
              {activeQuery.data && (
                <p className="admin-muted text-xs">
                  Active since {new Date(activeQuery.data.effectiveFrom).toLocaleString()} · set by{" "}
                  {activeQuery.data.setBy}
                </p>
              )}
              <StructuredConfigPanel
                key={selectedKey}
                configKey={selectedKey}
                load={(key) => getConfiguration(session!, key)}
                save={(key, body) => setConfiguration(session!, key, body)}
                onSaved={() => {
                  void activeQuery.refetch();
                  void queryClient.invalidateQueries({ queryKey: ["admin", "config", selectedKey] });
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
