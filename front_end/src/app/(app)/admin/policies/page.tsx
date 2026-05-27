"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { deactivatePolicy, listPolicies, savePolicy } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminPoliciesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ policyId: "", policyClass: "AVAILABILITY", policyDefinition: "{}" });

  const query = useQuery({
    queryKey: ["admin", "policies"],
    queryFn: () => listPolicies(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      let policyDefinition: unknown;
      try {
        policyDefinition = JSON.parse(form.policyDefinition);
      } catch {
        throw new Error("Invalid JSON");
      }
      return savePolicy(session!, { ...form, policyDefinition });
    },
    onSuccess: () => {
      toast.success("Policy version saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "policies"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (policyId: string) => deactivatePolicy(session!, policyId),
    onSuccess: () => {
      toast.success("Policy deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Policy registry</h1>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Save new policy version</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input className="admin-input" placeholder="policyId" value={form.policyId} onChange={(e) => setForm({ ...form, policyId: e.target.value })} />
          <input className="admin-input" placeholder="policyClass" value={form.policyClass} onChange={(e) => setForm({ ...form, policyClass: e.target.value })} />
        </div>
        <textarea className="admin-textarea min-h-[160px] font-mono text-xs" value={form.policyDefinition} onChange={(e) => setForm({ ...form, policyDefinition: e.target.value })} />
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Save policy
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Policy ID</th>
              <th>Class</th>
              <th>Version</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.policyId}</td>
                <td>{p.policyClass}</td>
                <td>{p.version}</td>
                <td>{p.isActive ? "yes" : "no"}</td>
                <td className="text-right">
                  {p.isActive && (
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      disabled={deactivateMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Deactivate policy "${p.policyId}" (v${p.version})?`)) {
                          deactivateMutation.mutate(p.policyId);
                        }
                      }}
                    >
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
