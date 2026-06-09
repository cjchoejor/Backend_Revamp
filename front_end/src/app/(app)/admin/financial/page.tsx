"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getFinancialConfig, listFinancialConfigKeys, setFinancialConfig } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
const FINANCIAL_LABELS: Record<string, string> = {
  "billing.salesTaxRate": "GST rate (decimal)",
  "billing.serviceChargeRate": "Service charge rate (decimal)",
  "advancePayment.thresholds": "Advance payment thresholds",
  "advancePayment.followUpWindowSeconds": "Advance follow-up (tier 1)",
  "advancePayment.escalationWindowSeconds": "Advance escalation (tier 2)",
  "payment.followUp.intervals": "Post-stay follow-up days",
  "payment.followUp.ttlDays": "Follow-up TTL (days)",
  "invoice.templates": "Invoice templates",
  "damage.rateList": "Damage rate list",
  "dispute.sla": "Dispute SLA timers",
  "fomOverride.frequency": "FOM override frequency",
  "writeOff.authority.thresholds": "Write-off authority",
};

export default function AdminFinancialPage() {
  const { session } = useSession();
  const [selectedKey, setSelectedKey] = useState("payment.followUp.intervals");

  const keysQuery = useQuery({
    queryKey: ["admin", "financial-keys"],
    queryFn: () => listFinancialConfigKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const keys = keysQuery.data?.keys ?? [];

  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Financial configuration</p>
        <h1 className="admin-display text-3xl">Payments & follow-up</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[70vh] overflow-y-auto p-3">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              className={`mb-1 block w-full rounded px-2 py-2 text-left text-sm ${
                key === selectedKey ? "bg-primary/10 text-foreground" : "text-[var(--admin-ink-soft)]"
              }`}
            >
              <div>{FINANCIAL_LABELS[key] ?? key}</div>
              <div className="font-mono text-[10px] opacity-60">{key}</div>
            </button>
          ))}
        </div>
        <div className="admin-panel p-5">
          <h2 className="admin-display text-lg">{FINANCIAL_LABELS[selectedKey] ?? selectedKey}</h2>
          <div className="mt-4">
            <StructuredConfigPanel
              key={selectedKey}
              configKey={selectedKey}
              load={(key) => getFinancialConfig(session, key as Parameters<typeof getFinancialConfig>[1])}
              save={(key, body) => setFinancialConfig(session, key as Parameters<typeof setFinancialConfig>[1], body)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
