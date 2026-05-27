"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getCommercialConfig, listCommercialConfigKeys, setCommercialConfig } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminCommercialPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("pricing.ratePlans");
  const [editor, setEditor] = useState("");
  const [notes, setNotes] = useState("");

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

  const loadKey = (key: string) => {
    setSelectedKey(key);
    getCommercialConfig(session!, key)
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
      return setCommercialConfig(session!, selectedKey, { configValue: parsed, notes: notes || null });
    },
    onSuccess: () => {
      toast.success("Commercial configuration superseded");
      void queryClient.invalidateQueries({ queryKey: ["admin", "commercial", selectedKey] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Commercial configuration</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">Rate plans, credit ceilings, cancellation tiers, and authority thresholds.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[70vh] overflow-y-auto p-3">
          {filteredKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => loadKey(key)}
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
          <textarea className="admin-textarea min-h-[320px] font-mono text-xs" value={editor} onChange={(e) => setEditor(e.target.value)} />
          <input className="admin-input" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            Save (supersede)
          </button>
        </div>
      </div>
    </div>
  );
}
