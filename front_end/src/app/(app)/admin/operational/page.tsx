"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getOperationalConfig, listOperationalConfigKeys, setOperationalConfig } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminOperationalPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("nightAudit.scheduleTime");
  const [editor, setEditor] = useState('""');
  const [notes, setNotes] = useState("");

  const keysQuery = useQuery({
    queryKey: ["admin", "operational-keys"],
    queryFn: () => listOperationalConfigKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const keys = keysQuery.data?.keys ?? [];

  const loadKey = (key: string) => {
    setSelectedKey(key);
    getOperationalConfig(session!, key)
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
      return setOperationalConfig(session!, selectedKey, { configValue: parsed, notes: notes || null });
    },
    onSuccess: () => {
      toast.success("Operational configuration saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "operational", selectedKey] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Operational schedules</p>
        <h1 className="admin-display text-3xl">Night audit & checkout</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="admin-panel max-h-[70vh] overflow-y-auto p-3">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => loadKey(key)}
              className={`mb-1 block w-full rounded px-2 py-1.5 text-left font-mono text-xs ${
                key === selectedKey ? "bg-[var(--admin-brass-glow)] text-[var(--admin-brass)]" : "text-[var(--admin-ink-soft)]"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="admin-panel space-y-4 p-5">
          <h2 className="admin-display font-mono text-sm">{selectedKey}</h2>
          <textarea className="admin-textarea min-h-[320px] font-mono text-xs" value={editor} onChange={(e) => setEditor(e.target.value)} />
          <input className="admin-input" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
