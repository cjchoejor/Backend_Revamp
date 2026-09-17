"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createPackage, deactivatePackage, listPackages, reactivatePackage, type PackageAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

const EMPTY = { name: "", description: "", inclusions: "", priceAdjustment: "", currency: "BTN" };

export default function AdminPackagesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState(EMPTY);
  const [showInactive, setShowInactive] = useState(false);
  const enabled = !!session && session.actorLevel === "L4";

  const query = useQuery({
    queryKey: ["admin", "packages", showInactive],
    queryFn: () => listPackages(session!, showInactive),
    enabled,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const inclusions = form.inclusions
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((label) => ({ label }));
      return createPackage(session!, {
        name: form.name,
        description: form.description || null,
        inclusions,
        priceAdjustment: form.priceAdjustment ? Number.parseFloat(form.priceAdjustment) : null,
        currency: form.currency || "BTN",
      });
    },
    onSuccess: () => {
      toast.success("Package created");
      setForm(EMPTY);
      void queryClient.invalidateQueries({ queryKey: ["admin", "packages"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivatePackage(session!, id),
    onSuccess: () => {
      toast.success("Package deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "packages"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivatePackage(session!, id),
    onSuccess: () => {
      toast.success("Package reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "packages"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Packages</h1>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="admin-input" placeholder="Price adjustment" type="number" value={form.priceAdjustment} onChange={(e) => setForm({ ...form, priceAdjustment: e.target.value })} />
        <input className="admin-input md:col-span-2" placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <label className="admin-muted text-xs md:col-span-2">
          Inclusions (one per line)
          <textarea className="admin-input mt-1 font-mono text-xs" rows={4} value={form.inclusions} onChange={(e) => setForm({ ...form, inclusions: e.target.value })} />
        </label>
        <button type="button" className="admin-btn w-fit" disabled={createMutation.isPending || !form.name} onClick={() => createMutation.mutate()}>
          Create package
        </button>
      </div>

      <label className="admin-muted flex items-center gap-2 text-xs">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
      </label>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Inclusions</th><th>Price adj.</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No packages found.</td></tr>}
            {items.map((p: PackageAdmin) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="text-xs">{Array.isArray(p.inclusions) ? (p.inclusions as Array<{ label?: string }>).map((i) => i.label).filter(Boolean).join(", ") : "—"}</td>
                <td className="font-mono text-xs">{p.priceAdjustment ?? "—"} {p.currency}</td>
                <td>{p.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {p.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate package",
                        message: `Deactivate "${p.name}"? It won't be available to add to new quotations.`,
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
