"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { deactivateVipRouting, listVipRoutings, reactivateVipRouting, saveVipRouting } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

function parseRoleList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function AdminVipRoutingPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    vipTier: "PLATINUM",
    notifyRoles: "FOM, GM",
    notifyActorIds: "",
  });

  const query = useQuery({
    queryKey: ["admin", "vip-routing"],
    queryFn: () => listVipRoutings(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      saveVipRouting(session!, {
        vipTier: form.vipTier.trim(),
        notifyRoles: parseRoleList(form.notifyRoles),
        notifyActorIds: parseRoleList(form.notifyActorIds),
      }),
    onSuccess: () => {
      toast.success("VIP routing saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "vip-routing"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateVipRouting(session!, id),
    onSuccess: () => {
      toast.success("VIP routing deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "vip-routing"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateVipRouting(session!, id),
    onSuccess: () => {
      toast.success("VIP routing reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "vip-routing"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">VIP notifications</p>
        <h1 className="admin-display text-3xl">VIP routing</h1>
        <p className="admin-muted mt-2 text-sm">Who gets notified when a VIP guest arrives. Use role codes (comma-separated), not JSON.</p>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <input className="admin-input" placeholder="VIP tier (e.g. PLATINUM)" value={form.vipTier} onChange={(e) => setForm({ ...form, vipTier: e.target.value })} />
        <label className="block space-y-1">
          <span className="admin-muted text-xs">Notify roles (comma-separated)</span>
          <input className="admin-input" placeholder="FOM, GM" value={form.notifyRoles} onChange={(e) => setForm({ ...form, notifyRoles: e.target.value })} />
        </label>
        <label className="block space-y-1">
          <span className="admin-muted text-xs">Notify specific staff IDs (optional, comma-separated)</span>
          <input className="admin-input" placeholder="Leave empty to use roles only" value={form.notifyActorIds} onChange={(e) => setForm({ ...form, notifyActorIds: e.target.value })} />
        </label>
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Save routing
        </button>
      </div>

      <div className="admin-panel p-4">
        <ul className="space-y-2 text-sm">
          {items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs">
                {r.vipTier} · {r.isActive ? "active" : "inactive"} · roles:{" "}
                {Array.isArray(r.notifyRoles) ? (r.notifyRoles as string[]).join(", ") : "—"}
              </span>
              {r.isActive ? (
                <button
                  type="button"
                  className="admin-btn shrink-0 text-[10px]"
                  disabled={deactivateMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`Deactivate VIP routing for ${r.vipTier}?`)) deactivateMutation.mutate(r.id);
                  }}
                >
                  Deactivate
                </button>
              ) : (
                <button
                  type="button"
                  className="admin-btn admin-btn-success shrink-0 text-[10px]"
                  disabled={reactivateMutation.isPending}
                  onClick={() => reactivateMutation.mutate(r.id)}
                >
                  Reactivate
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
