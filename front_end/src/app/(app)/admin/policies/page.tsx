"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CODE_POLICY_MODULES } from "@/lib/admin/config-schemas";
import { deactivatePolicy, listPolicies, savePolicy } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminPoliciesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    policyId: "",
    policyClass: "AVAILABILITY",
    description: "",
    enabled: true,
  });

  const query = useQuery({
    queryKey: ["admin", "policies"],
    queryFn: () => listPolicies(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      savePolicy(session!, {
        policyId: form.policyId.trim(),
        policyClass: form.policyClass.trim(),
        policyDefinition: {
          description: form.description.trim() || undefined,
          enabled: form.enabled,
          note: "Registry definition — runtime guards in back_end/src/policies are separate",
        },
      }),
    onSuccess: () => {
      toast.success("Policy version saved to database");
      setForm({ policyId: "", policyClass: "AVAILABILITY", description: "", enabled: true });
      void queryClient.invalidateQueries({ queryKey: ["admin", "policies"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
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
  const activePolicies = items.filter((p) => p.isActive);

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 04 · Workflow</p>
        <h1 className="admin-display text-3xl">Policy registry</h1>
      </div>

      <div className="admin-panel space-y-3 border-amber-500/30 bg-amber-500/5 p-5 text-sm">
        <h2 className="admin-display text-base">Two different kinds of “policies”</h2>
        <ol className="admin-muted list-decimal space-y-2 pl-5">
          <li>
            <strong className="text-[var(--admin-ink-soft)]">Runtime guards (TypeScript)</strong> — ~149 modules under{" "}
            <span className="font-mono text-xs">back_end/src/policies</span> (P01, P16, P31, …). These enforce stage
            gates at request time. They are <em>not</em> editable in this console; only a developer can change them in
            code.
          </li>
          <li>
            <strong className="text-[var(--admin-ink-soft)]">Policy registry (database)</strong> — versioned rows in{" "}
            <span className="font-mono text-xs">policy_registry</span> for future / supplemental definitions per ACIG.
            The list below is what is stored in the database. Wiring registry → runtime guards is not complete yet, so
            saving here records intent and audit history but does not replace TypeScript guards today.
          </li>
        </ol>
      </div>

      <section className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Runtime guards in code (read-only)</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {CODE_POLICY_MODULES.map((p) => (
            <li key={p.id} className="rounded border border-[var(--admin-rule)] px-3 py-2 text-sm">
              <span className="font-mono text-xs text-[var(--admin-brass)]">{p.id}</span>
              <span className="text-[var(--admin-ink-soft)]"> — {p.name}</span>
              <span className="admin-muted block text-[10px]">~{p.count} modules</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel space-y-4 p-5">
        <h2 className="admin-display text-lg">Add registry policy version</h2>
        <p className="admin-muted text-xs">Use plain fields — no JSON required.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            className="admin-input"
            placeholder="Policy ID (e.g. custom.noShow.grace)"
            value={form.policyId}
            onChange={(e) => setForm({ ...form, policyId: e.target.value })}
          />
          <input
            className="admin-input"
            placeholder="Class (e.g. AVAILABILITY)"
            value={form.policyClass}
            onChange={(e) => setForm({ ...form, policyClass: e.target.value })}
          />
        </div>
        <textarea
          className="admin-textarea min-h-[80px]"
          placeholder="Description for hotel staff"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enabled in registry
        </label>
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Save policy version
        </button>
      </section>

      <section className="admin-panel overflow-x-auto p-4">
        <h2 className="admin-display mb-3 text-lg">Database registry ({activePolicies.length} active)</h2>
        {items.length === 0 ? (
          <p className="admin-muted text-sm">No policy versions in the database yet. Create one above or re-run seed after update.</p>
        ) : (
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
        )}
      </section>
    </div>
  );
}
