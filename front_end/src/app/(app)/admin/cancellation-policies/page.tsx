"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createCancellationPolicy,
  deactivateCancellationPolicy,
  listCancellationPolicies,
  reactivateCancellationPolicy,
  type CancellationPolicyAdmin,
  type PenaltyTier,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

const DEFAULT_TIERS: PenaltyTier[] = [
  { daysBeforeArrival: 7, penaltyPercentage: 0 },
  { daysBeforeArrival: 3, penaltyPercentage: 50 },
  { daysBeforeArrival: 0, penaltyPercentage: 100 },
];

export default function AdminCancellationPoliciesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [noShowTreatment, setNoShowTreatment] = useState("FULL_PENALTY");
  const [tiers, setTiers] = useState<PenaltyTier[]>(DEFAULT_TIERS);
  const [showInactive, setShowInactive] = useState(false);
  const enabled = !!session && session.actorLevel === "L4";

  const query = useQuery({
    queryKey: ["admin", "cancellation-policies", showInactive],
    queryFn: () => listCancellationPolicies(session!, showInactive),
    enabled,
  });

  const createMutation = useMutation({
    mutationFn: () => createCancellationPolicy(session!, { name, penaltyTiers: tiers, noShowTreatment }),
    onSuccess: () => {
      toast.success("Cancellation policy created");
      setName("");
      setTiers(DEFAULT_TIERS);
      void queryClient.invalidateQueries({ queryKey: ["admin", "cancellation-policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateCancellationPolicy(session!, id),
    onSuccess: () => {
      toast.success("Policy deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "cancellation-policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateCancellationPolicy(session!, id),
    onSuccess: () => {
      toast.success("Policy reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "cancellation-policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const items = query.data?.items ?? [];

  const setTier = (i: number, key: keyof PenaltyTier, value: number) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, [key]: value } : t)));

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Cancellation policies</h1>
        <p className="admin-muted mt-1">Penalty tiers must be non-decreasing as the arrival date approaches.</p>
      </div>

      <div className="admin-panel space-y-4 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <input className="admin-input" placeholder="Policy name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="admin-input" placeholder="No-show treatment" value={noShowTreatment} onChange={(e) => setNoShowTreatment(e.target.value)} />
        </div>

        <div className="space-y-2">
          <p className="admin-eyebrow">Penalty tiers</p>
          {tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="admin-input w-40 text-xs" type="number" value={t.daysBeforeArrival} onChange={(e) => setTier(i, "daysBeforeArrival", Number.parseInt(e.target.value, 10) || 0)} />
              <span className="admin-muted text-xs">days before →</span>
              <input className="admin-input w-28 text-xs" type="number" value={t.penaltyPercentage} onChange={(e) => setTier(i, "penaltyPercentage", Number.parseFloat(e.target.value) || 0)} />
              <span className="admin-muted text-xs">% penalty</span>
              <button type="button" className="admin-btn text-[10px]" onClick={() => setTiers((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="admin-btn text-[10px]" onClick={() => setTiers((prev) => [...prev, { daysBeforeArrival: 0, penaltyPercentage: 0 }])}>Add tier</button>
        </div>

        <button type="button" className="admin-btn w-fit" disabled={createMutation.isPending || !name} onClick={() => createMutation.mutate()}>
          Create policy
        </button>
      </div>

      <label className="admin-muted flex items-center gap-2 text-xs">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
      </label>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead><tr><th>Name</th><th>Tiers</th><th>No-show</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No cancellation policies found.</td></tr>}
            {items.map((p: CancellationPolicyAdmin) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="text-xs">{(p.penaltyTiers ?? []).map((t) => `${t.daysBeforeArrival}d→${t.penaltyPercentage}%`).join(", ")}</td>
                <td className="font-mono text-xs">{p.noShowTreatment}</td>
                <td>{p.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {p.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate cancellation policy",
                        message: `Deactivate "${p.name}"? New reservations won't be able to attach this policy; existing reservations carry a frozen copy and are unaffected.`,
                        confirmLabel: "Deactivate",
                        variant: "danger",
                      });
                      if (ok) deactivateMutation.mutate(p.id);
                    }}>
                      Deactivate
                    </button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(p.id)}>
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
