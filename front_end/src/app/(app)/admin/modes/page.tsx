"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { activateMode, deactivateMode, listModes, saveMode } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminModesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    modeKey: "",
    displayName: "",
    description: "",
    config: "{}",
  });

  const query = useQuery({
    queryKey: ["admin", "modes"],
    queryFn: () => listModes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      let config: unknown;
      try {
        config = JSON.parse(form.config);
      } catch {
        throw new Error("Invalid JSON in config");
      }
      return saveMode(session!, {
        modeKey: form.modeKey,
        displayName: form.displayName,
        description: form.description || null,
        config,
      });
    },
    onSuccess: () => {
      toast.success("Mode saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => activateMode(session!, id),
    onSuccess: () => {
      toast.success("Mode activated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Activate failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateMode(session!, id),
    onSuccess: () => {
      toast.success("Mode deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "modes"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Modes</h1>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Create / save mode</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input className="admin-input" placeholder="modeKey" value={form.modeKey} onChange={(e) => setForm({ ...form, modeKey: e.target.value })} />
          <input className="admin-input" placeholder="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </div>
        <input className="admin-input" placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <textarea className="admin-textarea min-h-[120px] font-mono text-xs" value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} />
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Save mode
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Lifecycle</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs">{m.modeKey}</td>
                <td>{m.displayName}</td>
                <td>{m.lifecycleState}</td>
                <td>{m.isActive ? "yes" : "no"}</td>
                <td className="space-x-2 text-right">
                  {!m.isActive && (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => activateMutation.mutate(m.id)}>
                      Activate
                    </button>
                  )}
                  {m.isActive && (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => deactivateMutation.mutate(m.id)}>
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
