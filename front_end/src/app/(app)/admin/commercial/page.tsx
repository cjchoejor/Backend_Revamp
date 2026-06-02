"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getCommercialConfig, listCommercialConfigKeys, setCommercialConfig } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminCommercialPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("pricing.ratePlans");

  const keysQuery = useQuery({
    queryKey: ["admin", "commercial-keys"],
    queryFn: () => listCommercialConfigKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const keys = keysQuery.data?.keys ?? [];

  const activeQuery = useQuery({
    queryKey: ["admin", "commercial", selectedKey],
    queryFn: () => getCommercialConfig(session!, selectedKey),
    enabled: !!session && session.actorLevel === "L4" && !!selectedKey,
  });

  const filteredKeys = useMemo(() => {
    const q = selectedKey.trim().toLowerCase();
    if (!q || keys.includes(selectedKey)) return keys;
    return keys.filter((k) => k.toLowerCase().includes(q));
  }, [keys, selectedKey]);

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Commercial configuration</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Rate plans, credit ceilings, cancellation tiers, and authority thresholds. Edit fields below; use Advanced JSON if you need to paste a value.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[70vh] overflow-y-auto p-3">
          {filteredKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              className={`mb-1 block w-full rounded px-2 py-1.5 text-left font-mono text-xs ${
                key === selectedKey ? "bg-[var(--admin-brass-glow)] text-[var(--admin-brass)]" : "text-[var(--admin-ink-soft)] hover:text-[var(--admin-brass)]"
              }`}
            >
              {key}
            </button>
          ))}
        </div>

        <div className="admin-panel space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="admin-display font-mono text-sm">{selectedKey}</h2>
            {activeQuery.data?.isSystemDefault && <span className="admin-tag">system default</span>}
          </div>
          <StructuredConfigPanel
            key={selectedKey}
            configKey={selectedKey}
            load={(key) => getCommercialConfig(session!, key)}
            save={(key, body) => setCommercialConfig(session!, key, body)}
            onSaved={() => {
              void activeQuery.refetch();
              void queryClient.invalidateQueries({ queryKey: ["admin", "commercial", selectedKey] });
            }}
          />
        </div>
      </div>
    </div>
  );
}
