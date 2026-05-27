"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { workflowConfigKeys } from "@/config/admin-nav";
import { getConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import Link from "next/link";

export default function AdminWorkflowPage() {
  const { session } = useSession();
  const [activeKey, setActiveKey] = useState<string>(workflowConfigKeys[0].key);

  const configQuery = useQuery({
    queryKey: ["admin", "workflow", activeKey],
    queryFn: () => getConfiguration(session!, activeKey),
    enabled: !!session && session.actorLevel === "L4",
  });

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Workflow & thresholds</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          High-impact keys used by timers, night audit, advance payment, and credit ceiling engines.
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
        <p className="font-mono text-sm text-[var(--admin-brass)]">{activeKey}</p>
        {configQuery.data?.isSystemDefault && <span className="admin-tag mt-2">system default</span>}
        <pre className="mt-4 overflow-auto rounded border border-[var(--admin-rule)] bg-[var(--admin-bg)] p-4 font-mono text-xs text-[var(--admin-ink-soft)]">
          {configQuery.isLoading
            ? "Loading…"
            : JSON.stringify(configQuery.data?.configValue ?? null, null, 2)}
        </pre>
        <Link href={`/admin/configuration`} className="admin-btn mt-4 inline-flex">
          Edit in configuration editor
        </Link>
        <p className="admin-muted mt-2 text-xs">
          Select <span className="font-mono text-[var(--admin-brass)]">{activeKey}</span> in the configuration
          browser to supersede.
        </p>
      </div>
    </div>
  );
}
