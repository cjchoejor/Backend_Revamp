"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createSeason, deactivateSeason, listSeasons, reactivateSeason, type SeasonAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const EMPTY = { name: "", startDate: "", endDate: "", rateMultiplier: "", priority: "0" };

export default function AdminSeasonsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [showInactive, setShowInactive] = useState(false);
  const enabled = !!session && session.actorLevel === "L4";

  const query = useQuery({
    queryKey: ["admin", "seasons", showInactive],
    queryFn: () => listSeasons(session!, showInactive),
    enabled,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createSeason(session!, {
        name: form.name,
        startDate: new Date(form.startDate).toISOString(),
        endDate: new Date(form.endDate).toISOString(),
        rateMultiplier: form.rateMultiplier ? Number.parseFloat(form.rateMultiplier) : null,
        priority: Number.parseInt(form.priority, 10) || 0,
      }),
    onSuccess: () => {
      toast.success("Season created");
      setForm(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["admin", "seasons"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateSeason(session!, id),
    onSuccess: () => {
      toast.success("Season deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "seasons"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateSeason(session!, id),
    onSuccess: () => {
      toast.success("Season reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "seasons"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Seasons</h1>
        <p className="admin-muted mt-1">Active seasons may not overlap.</p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-3">
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label className="admin-muted text-xs">Start<input className="admin-input mt-1" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
        <label className="admin-muted text-xs">End<input className="admin-input mt-1" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></label>
        <input className="admin-input" placeholder="Rate multiplier (e.g. 1.25)" type="number" step="0.01" value={form.rateMultiplier} onChange={(e) => setForm({ ...form, rateMultiplier: e.target.value })} />
        <input className="admin-input" placeholder="Priority" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending || !form.name || !form.startDate || !form.endDate} onClick={() => createMutation.mutate()}>
          Create season
        </button>
      </div>

      <label className="admin-muted flex items-center gap-2 text-xs">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
      </label>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Start</th><th>End</th><th>Multiplier</th><th>Priority</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="admin-muted">No seasons found.</td></tr>}
            {items.map((s: SeasonAdmin) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="font-mono text-xs">{s.startDate.slice(0, 10)}</td>
                <td className="font-mono text-xs">{s.endDate.slice(0, 10)}</td>
                <td>{s.rateMultiplier ?? "—"}</td>
                <td>{s.priority}</td>
                <td>{s.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {s.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => { if (window.confirm(`Deactivate season "${s.name}"?`)) deactivateMutation.mutate(s.id); }}>
                      Deactivate
                    </button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(s.id)}>
                      Reactivate
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
