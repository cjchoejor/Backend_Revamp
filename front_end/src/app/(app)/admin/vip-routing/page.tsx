"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { deactivateVipRouting, listVipRoutings, saveVipRouting } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminVipRoutingPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    vipTier: "PLATINUM",
    notifyRoles: '["FOM", "GM"]',
    notifyActorIds: "[]",
  });

  const query = useQuery({
    queryKey: ["admin", "vip-routing"],
    queryFn: () => listVipRoutings(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      let notifyRoles: unknown;
      let notifyActorIds: unknown;
      try {
        notifyRoles = JSON.parse(form.notifyRoles);
        notifyActorIds = JSON.parse(form.notifyActorIds);
      } catch {
        throw new Error("Invalid JSON in roles or actor IDs");
      }
      return saveVipRouting(session!, { vipTier: form.vipTier, notifyRoles, notifyActorIds });
    },
    onSuccess: () => {
      toast.success("VIP routing saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "vip-routing"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateVipRouting(session!, id),
    onSuccess: () => {
      toast.success("VIP routing deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "vip-routing"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">VIP notifications</p>
        <h1 className="admin-display text-3xl">VIP routing</h1>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <input className="admin-input" placeholder="VIP tier" value={form.vipTier} onChange={(e) => setForm({ ...form, vipTier: e.target.value })} />
        <textarea className="admin-textarea min-h-[80px] font-mono text-xs" value={form.notifyRoles} onChange={(e) => setForm({ ...form, notifyRoles: e.target.value })} placeholder="notifyRoles JSON array" />
        <textarea className="admin-textarea min-h-[80px] font-mono text-xs" value={form.notifyActorIds} onChange={(e) => setForm({ ...form, notifyActorIds: e.target.value })} placeholder="notifyActorIds JSON array" />
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Save routing
        </button>
      </div>

      <div className="admin-panel p-4">
        <ul className="space-y-2 text-sm">
          {items.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 font-mono text-xs">
              <span>
                {r.vipTier} · {r.isActive ? "active" : "inactive"} · roles {JSON.stringify(r.notifyRoles)}
              </span>
              {r.isActive && (
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
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
