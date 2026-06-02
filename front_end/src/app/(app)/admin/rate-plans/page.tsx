"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createRatePlan,
  deactivateRatePlan,
  getWalkInRatePlan,
  listRatePlans,
  reactivateRatePlan,
  setWalkInRatePlan,
  updateRatePlan,
  type RatePlanAdmin,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const RATE_PLAN_TYPES = ["INDIVIDUAL", "PROMOTIONAL", "TIER", "CHANNEL", "RACK"] as const;
type RatePlanTypeLiteral = (typeof RATE_PLAN_TYPES)[number];
const EMPTY = { name: "", description: "", type: "INDIVIDUAL" as RatePlanTypeLiteral, baseRate: "", currency: "BTN", msr: "", overrideMargin: "" };

export default function AdminRatePlansPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const resetForm = () => {
    setForm(EMPTY);
    setEditingId(null);
  };

  const enabled = !!session && session.actorLevel === "L4";
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "rate-plans"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "walk-in-rate-plan"] });
  };

  const query = useQuery({
    queryKey: ["admin", "rate-plans", showInactive],
    queryFn: () => listRatePlans(session!, showInactive),
    enabled,
  });

  const walkInQuery = useQuery({
    queryKey: ["admin", "walk-in-rate-plan"],
    queryFn: () => getWalkInRatePlan(session!),
    enabled,
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description || null,
        type: form.type,
        baseRate: Number.parseFloat(form.baseRate) || 0,
        currency: form.currency || "BTN",
        msr: form.msr ? Number.parseFloat(form.msr) : null,
        overrideMargin: form.overrideMargin ? Number.parseFloat(form.overrideMargin) : null,
      };
      return editingId
        ? updateRatePlan(session!, editingId, body)
        : createRatePlan(session!, body);
    },
    onSuccess: () => {
      toast.success(editingId ? "Rate plan updated" : "Rate plan created");
      resetForm();
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateRatePlan(session!, id),
    onSuccess: () => {
      toast.success("Rate plan deactivated");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateRatePlan(session!, id),
    onSuccess: () => {
      toast.success("Rate plan reactivated");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  const marginMutation = useMutation({
    mutationFn: ({ id, margin }: { id: string; margin: number | null }) => updateRatePlan(session!, id, { overrideMargin: margin }),
    onSuccess: () => {
      toast.success("Override margin saved");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const walkInMutation = useMutation({
    mutationFn: (id: string) => setWalkInRatePlan(session!, id),
    onSuccess: () => {
      toast.success("Walk-in rate plan set");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to set walk-in"),
  });

  if (!session || session.actorLevel !== "L4") return null;

  const items = query.data?.items ?? [];
  const walkInId = walkInQuery.data?.ratePlanId ?? null;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Rate plans</h1>
        <p className="admin-muted mt-1">
          Walk-in plan:{" "}
          <span className="font-mono">{walkInQuery.data?.ratePlan?.name ?? (walkInId ? walkInId : "not set")}</span>
        </p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-3">
        <p className="admin-eyebrow col-span-full">
          {editingId ? "Edit rate plan" : "Create rate plan"}
        </p>
        {editingId && (
          <p className="admin-muted col-span-full -mt-2 text-xs">
            Confirmed reservations carry a frozen rate snapshot from S4 and won't be affected. Only un-confirmed
            bookings (S1–S3) pick up the new value on their next pricing read.
          </p>
        )}
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select
          className="admin-select"
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as RatePlanTypeLiteral })}
          title="Type drives priority in the PricingPipelineEngine (INDIVIDUAL → PROMOTIONAL → TIER → CHANNEL → RACK)."
        >
          {RATE_PLAN_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input className="admin-input" placeholder="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
        <input className="admin-input" placeholder="Base rate (nightly)" type="number" value={form.baseRate} onChange={(e) => setForm({ ...form, baseRate: e.target.value })} />
        <input className="admin-input" placeholder="Minimum sell rate (MSR, optional)" type="number" value={form.msr} onChange={(e) => setForm({ ...form, msr: e.target.value })} title="MSR is the floor that discounts + override paths may not cross." />
        <input className="admin-input" placeholder="Override margin (e.g. 0.05)" type="number" step="0.01" value={form.overrideMargin} onChange={(e) => setForm({ ...form, overrideMargin: e.target.value })} />
        <input className="admin-input md:col-span-3" placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="col-span-full flex flex-wrap gap-2">
          <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending || !form.name} onClick={() => saveMutation.mutate()}>
            {editingId ? "Save changes" : "Create rate plan"}
          </button>
          {editingId && (
            <button type="button" className="admin-btn w-fit" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <label className="admin-muted flex items-center gap-2 text-xs">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
      </label>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Base rate</th>
              <th>MSR</th>
              <th>Override margin</th>
              <th>Walk-in</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="admin-muted">No rate plans found.</td>
              </tr>
            )}
            {items.map((rp: RatePlanAdmin) => (
              <tr key={rp.id}>
                <td>{rp.name}</td>
                <td className="font-mono text-[10px]">{rp.type}</td>
                <td className="font-mono text-xs">{rp.baseRate} {rp.currency}</td>
                <td className="font-mono text-xs">{rp.msr ?? "—"}</td>
                <td>
                  <input
                    className="admin-input w-24 text-xs"
                    type="number"
                    step="0.01"
                    defaultValue={rp.overrideMargin ?? ""}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const margin = raw === "" ? null : Number.parseFloat(raw);
                      if ((rp.overrideMargin ?? "") !== raw) marginMutation.mutate({ id: rp.id, margin });
                    }}
                  />
                </td>
                <td>
                  {walkInId === rp.id ? (
                    <span className="admin-tag admin-tag-ok">walk-in</span>
                  ) : (
                    rp.isActive && (
                      <button type="button" className="admin-btn text-[10px]" onClick={() => walkInMutation.mutate(rp.id)}>
                        Set walk-in
                      </button>
                    )
                  )}
                </td>
                <td>{rp.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  <div className="flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      onClick={() => {
                        setEditingId(rp.id);
                        setForm({
                          name: rp.name,
                          description: rp.description ?? "",
                          type: (RATE_PLAN_TYPES as readonly string[]).includes(rp.type) ? (rp.type as RatePlanTypeLiteral) : "INDIVIDUAL",
                          baseRate: String(rp.baseRate),
                          currency: rp.currency,
                          msr: rp.msr ?? "",
                          overrideMargin: rp.overrideMargin ?? "",
                        });
                        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Edit
                    </button>
                    {rp.isActive ? (
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        disabled={deactivateMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Deactivate rate plan "${rp.name}"?`)) deactivateMutation.mutate(rp.id);
                        }}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="admin-btn admin-btn-success text-[10px]"
                        disabled={reactivateMutation.isPending}
                        onClick={() => reactivateMutation.mutate(rp.id)}
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
