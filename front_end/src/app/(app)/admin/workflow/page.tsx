"use client";

import { useState } from "react";
import { workflowConfigKeys } from "@/config/admin-nav";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getConfiguration, setConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { getConfigSchema } from "@/lib/admin/config-schemas";

export default function AdminWorkflowPage() {
  const { session } = useSession();
  const [activeKey, setActiveKey] = useState<string>(workflowConfigKeys[0].key);

  if (!session || session.actorLevel !== "L4") return null;

  const active = workflowConfigKeys.find((k) => k.key === activeKey);
  const hasForm = !!getConfigSchema(activeKey);

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Workflow & thresholds</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          High-impact timing keys for advance payment, credit ceiling, tax, and stage dwell. Use{" "}
          <a href="/admin/timers-workers" className="text-primary underline">
            Timers & workers
          </a>{" "}
          for the full background-job catalogue.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {workflowConfigKeys.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`admin-btn ${activeKey === item.key ? "opacity-100" : "opacity-60"}`}
            onClick={() => setActiveKey(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="admin-panel p-5">
        <h2 className="admin-display text-lg">{active?.label ?? activeKey}</h2>
        <p className="admin-muted font-mono text-xs">{activeKey}</p>
        {!hasForm && (
          <p className="admin-muted mt-2 text-xs">
            This key uses a custom shape — use the form below or the full configuration browser for JSON editing.
          </p>
        )}
        <div className="mt-4">
          <StructuredConfigPanel
            key={activeKey}
            configKey={activeKey}
            load={(key) => getConfiguration(session, key)}
            save={(key, body) => setConfiguration(session, key, body)}
          />
        </div>
      </div>
    </div>
  );
}
