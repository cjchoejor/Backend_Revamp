"use client";

import { useState } from "react";
import { TIMER_WORKER_CONFIG_KEYS } from "@/lib/admin/config-schemas";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getConfiguration, setConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminTimersWorkersPage() {
  const { session } = useSession();
  const [activeKey, setActiveKey] = useState(TIMER_WORKER_CONFIG_KEYS[0]?.key ?? "");

  const active = TIMER_WORKER_CONFIG_KEYS.find((k) => k.key === activeKey);

  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Timers & background workers</h1>
        <p className="admin-muted mt-2 max-w-3xl text-sm">
          These settings live in the database (<span className="font-mono">configuration_entries</span>) and control when
          background jobs fire (hold expiry, follow-ups, night audit, dwell warnings, and more). They are{" "}
          <strong>not</strong> the TypeScript policy files under <span className="font-mono">back_end/src/policies</span>
          — those are compiled guards and are changed only by developers.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="admin-panel max-h-[75vh] overflow-y-auto p-2">
          {TIMER_WORKER_CONFIG_KEYS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveKey(item.key)}
              className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                activeKey === item.key
                  ? "bg-primary/10 text-foreground"
                  : "text-[var(--admin-ink-soft)] hover:bg-[var(--admin-bg)]"
              }`}
            >
              <div className="font-medium">{item.title}</div>
              {item.worker && <div className="font-mono text-[10px] opacity-60">{item.worker}</div>}
            </button>
          ))}
        </div>

        <div className="admin-panel p-5">
          {active && (
            <>
              <h2 className="admin-display text-lg">{active.title}</h2>
              <p className="admin-muted font-mono text-xs">{active.key}</p>
              <div className="mt-4">
                <StructuredConfigPanel
                  key={active.key}
                  configKey={active.key}
                  load={(key) => getConfiguration(session, key)}
                  save={(key, body) => setConfiguration(session, key, body)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
