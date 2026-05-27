"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getConfiguration, listConfigurationKeys, setConfiguration } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminConfigurationPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");
  const [editor, setEditor] = useState("");
  const [notes, setNotes] = useState("");

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

  const loadKey = (key: string) => {
    setSelectedKey(key);
    getConfiguration(session!, key)
      .then((row) => {
        setEditor(JSON.stringify(row.configValue, null, 2));
        setNotes(row.notes ?? "");
      })
      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load"));
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(editor);
      } catch {
        throw new Error("Invalid JSON");
      }
      return setConfiguration(session!, selectedKey, { configValue: parsed, notes: notes || null });
    },
    onSuccess: () => {
      toast.success("Configuration superseded (new temporal row)");
      void queryClient.invalidateQueries({ queryKey: ["admin", "config", selectedKey] });
      void keysQuery.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow & keys</p>
        <h1 className="admin-display text-3xl">Configuration entries</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Values are never edited in place — saving creates a new row and closes the prior active window
          (effectiveFrom / effectiveTo). Seeded defaults show a system-default indicator.
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
                  onClick={() => loadKey(key)}
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
              <textarea
                className="admin-textarea min-h-[280px] font-mono text-xs"
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
              />
              <input
                className="admin-input"
                placeholder="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                type="button"
                className="admin-btn"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? "Saving…" : "Supersede with new value"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
