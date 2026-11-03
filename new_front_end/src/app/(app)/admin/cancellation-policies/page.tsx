"use client";

import { AdmField } from "@/components/admin/field-title";
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
import { Help } from "@/components/ds/help";
import { NotUsedYet, SettingsList } from "@/components/admin/settings-list";
import { Suspense } from "react";
import { Control } from "@/components/admin/setting-form";

const noShowWord = (v: string) => (v === "FULL_PENALTY" ? "Charge the full penalty" : v);

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
  const [noShowTreatment, setNoShowTreatment] = useState("Charge the full penalty");
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

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Rules</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Cancellation policies
          <Help label="Cancellation policies">What a guest pays if they cancel. The charge the desk applies is first; the policies below it are wording kept on file.</Help>
        </h1>
      </div>

      <Suspense>
        <SettingsList groups={[{ keys: ["cancellation.policyTiers"] }]} />
      </Suspense>

      <div className="set-group">
        <h2>Policies on file</h2>
        <NotUsedYet>Nothing charges from these policies yet, and saving one does not change what the desk charges. The charge is the one above.</NotUsedYet>
      </div>

      <div className="admin-panel space-y-4 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <AdmField label="Policy name">
            <input className="admin-input" value={name} onChange={(e) => setName(e.target.value)} />
          </AdmField>
        </div>

        <div className="sf-field">
          <span className="sf-label">
            If the guest does not come
            <Help label="If the guest does not come">Words kept with the policy. The no-show charge itself is set under Online booking sites and at the booking.</Help>
          </span>
          <input className="admin-input sf-input wide" value={noShowTreatment} onChange={(e) => setNoShowTreatment(e.target.value)} />
        </div>

        <div className="space-y-2">
          <span className="sf-label">The charge, by days before arrival</span>
          <Control
            f={{
              kind: "rows",
              label: "The charge",
              addLabel: "Add a line",
              word: ["line", "lines"],
              blank: { daysBeforeArrival: 0, penaltyPercentage: 0 },
              columns: [
                { kind: "number", key: "daysBeforeArrival", label: "Cancelled with this many days left", unit: "days", min: 0, whole: true },
                { kind: "percent", key: "penaltyPercentage", label: "They pay", stored: "whole" },
              ],
            }}
            value={tiers}
            onChange={(v) => setTiers(v as PenaltyTier[])}
          />
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
          <thead><tr><th>Name</th><th>The charge</th><th>If they do not come</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No cancellation policies found.</td></tr>}
            {items.map((p: CancellationPolicyAdmin) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{(p.penaltyTiers ?? []).map((t) => `${t.daysBeforeArrival} days: ${t.penaltyPercentage}%`).join(" · ")}</td>
                <td>{noShowWord(p.noShowTreatment)}</td>
                <td>{p.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {p.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate cancellation policy",
                        message: `Deactivate "${p.name}"? It stays on file. This does not change what the desk charges.`,
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
