"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getOperationalConfig, listOperationalConfigKeys, setOperationalConfig } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { getConfigSchema } from "@/lib/admin/config-schemas";

const OPERATIONAL_LABELS: Record<string, string> = {
  "nightAudit.scheduleTime": "Night audit schedule (cron)",
  "nightAudit.schedule": "Stay-night reminder hour",
  "nightAudit.expectedChargesRules": "Expected charges rules",
  "nightAudit.expectedDailyFAndBCharge": "Expected daily F&B charge",
  "checkout.cutoffTime": "Checkout cutoff time",
  "roomAssignment.priorityRules": "Room assignment priority",
  "housekeeping.sla.windowMinutes": "Housekeeping SLA (minutes)",
  "inspection.postCheckout.windowHours": "Post-checkout inspection window (hours)",
};

export default function AdminOperationalPage() {
  const { session } = useSession();
  const [selectedKey, setSelectedKey] = useState("nightAudit.scheduleTime");

  const keysQuery = useQuery({
    queryKey: ["admin", "operational-keys"],
    queryFn: () => listOperationalConfigKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const keys = keysQuery.data?.keys ?? [];

  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Operational schedules</p>
        <h1 className="admin-display text-3xl">Night audit & checkout</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Schedules and SLA windows stored in the database. Timer-related keys also appear under Timers & workers.
        </p>
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
              <div>{OPERATIONAL_LABELS[key] ?? key}</div>
              <div className="font-mono text-[10px] opacity-60">{key}</div>
            </button>
          ))}
        </div>
        <div className="admin-panel p-5">
          <h2 className="admin-display text-lg">{OPERATIONAL_LABELS[selectedKey] ?? selectedKey}</h2>
          {!getConfigSchema(selectedKey) && (
            <p className="admin-muted mt-1 text-xs">No dedicated form yet — use advanced JSON mode below.</p>
          )}
          <div className="mt-4">
            <StructuredConfigPanel
              key={selectedKey}
              configKey={selectedKey}
              load={(key) => getOperationalConfig(session, key as Parameters<typeof getOperationalConfig>[1])}
              save={(key, body) => setOperationalConfig(session, key as Parameters<typeof setOperationalConfig>[1], body)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
