"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StructuredConfigPanel } from "@/components/admin/structured-config-panel";
import { getConfiguration, listConfigurationKeys, setConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminConfigurationPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");

  const keysQuery = useQuery({
    queryKey: ["admin", "config-keys"],
    queryFn: () => listConfigurationKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const keys = keysQuery.data?.keys ?? [];
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
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow & keys</p>
        <h1 className="admin-display text-3xl">Configuration entries</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Values are never edited in place — saving creates a new row and closes the prior active window. Keys with a
          friendly form use structured fields; others fall back to the generic editor (with an Advanced JSON escape
          hatch). For timers and workers, prefer{" "}
          <a href="/admin/timers-workers" className="text-primary underline">
            Timers & workers
          </a>
          .
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
