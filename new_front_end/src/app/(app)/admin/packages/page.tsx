"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createPackage, deactivatePackage, listPackages, reactivatePackage, type PackageAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";
import { Help } from "@/components/ds/help";
import { NotUsedYet } from "@/components/admin/settings-list";
import { Control } from "@/components/admin/setting-form";

const EMPTY = { name: "", description: "", inclusions: [] as string[], priceAdjustment: "", currency: "BTN" };

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
      const inclusions = form.inclusions.map((label) => ({ label }));
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
        <p className="admin-eyebrow mb-2">Rates and limits</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Stay packages
          <Help label="Stay packages">A package adds things to a stay, such as a dinner or a tour, for a set price. These are not agency rates: those are on the Travel agents and Corporate accounts pages.</Help>
        </h1>
      </div>

      <NotUsedYet>A package saved here cannot be added to a quotation yet.</NotUsedYet>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <span className="sf-unit">
          <span>Nu</span>
          <input className="admin-input" placeholder="Added to the price" type="number" value={form.priceAdjustment} onChange={(e) => setForm({ ...form, priceAdjustment: e.target.value })} />
        </span>
        <input className="admin-input md:col-span-2" placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="sf-field md:col-span-2">
          <span className="sf-label">What it includes</span>
          <Control f={{ kind: "tags", label: "What it includes", placeholder: "Dinner on arrival", addLabel: "Add" }} value={form.inclusions} onChange={(v) => setForm({ ...form, inclusions: v as string[] })} />
        </div>
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
            <tr><th>Name</th><th>Inclusions</th><th>Added to the price</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No packages found.</td></tr>}
            {items.map((p: PackageAdmin) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="text-xs">{Array.isArray(p.inclusions) ? (p.inclusions as Array<{ label?: string }>).map((i) => i.label).filter(Boolean).join(", ") : "—"}</td>
                <td>{p.priceAdjustment != null ? `${p.currency === "BTN" ? "Nu" : p.currency} ${p.priceAdjustment}` : "—"}</td>
                <td>{p.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {p.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate package",
                        message: `Deactivate "${p.name}"? It stays on file.`,
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
