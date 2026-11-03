"use client";

import { AdmField } from "@/components/admin/field-title";
import { Help } from "@/components/ds/help";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getHouseTariff,
  listHouseTariffVersions,
  saveHouseTariff,
  type HouseTariffAdmin,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

/**
 * House tariff — the hotel's OWN add-on price list.
 *
 * Applies to every booking with no negotiated rate card (walk-in, direct, OTA). Agent and
 * corporate bookings use their own rate card and deliberately do NOT fall back here.
 *
 * The room rate is not on this page: room rates live on Rate plans, which also carry the MSR
 * floor, the season multiplier and the discount pipeline.
 */

/** Blank string = "not configured" (plan falls back to its meals). "0" = deliberately free. */
const FIELDS = [
  "extraBedRate",
  "breakfastRate",
  "lunchRate",
  "dinnerRate",
  "cpRate",
  "mapLunchRate",
  "mapDinnerRate",
  "apRate",
] as const;
type Field = (typeof FIELDS)[number];
type FormState = Record<Field, string> & { currency: string; notes: string };

const EMPTY: FormState = {
  extraBedRate: "", breakfastRate: "", lunchRate: "", dinnerRate: "",
  cpRate: "", mapLunchRate: "", mapDinnerRate: "", apRate: "",
  currency: "BTN", notes: "",
};

/** String draft → number | null. Empty stays null so "not configured" survives a round trip. */
function num(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Always 2 decimals — house money-display rule. */
function money(v: string | number | null | undefined, currency = "BTN") {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  if (!Number.isFinite(n)) return "—";
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function RateInput({
  label, hint, value, onChange,
}: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <AdmField label={label} hint={hint}>
      <input
        className="admin-input"
        type="number"
        min="0"
        step="0.01"
        placeholder="not set"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </AdmField>
  );
}

export default function AdminHouseTariffPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const enabled = !!session && session.actorLevel === "L4";

  const activeQuery = useQuery({
    queryKey: ["admin", "house-tariff"],
    queryFn: () => getHouseTariff(session!),
    enabled,
  });
  const versionsQuery = useQuery({
    queryKey: ["admin", "house-tariff", "versions"],
    queryFn: () => listHouseTariffVersions(session!),
    enabled,
  });

  const active = activeQuery.data?.active ?? null;

  // Seed the form from the active tariff once it arrives, without stomping edits in progress.
  useEffect(() => {
    if (!active || loadedId === active.id) return;
    setForm({
      extraBedRate: active.extraBedRate ?? "",
      breakfastRate: active.breakfastRate ?? "",
      lunchRate: active.lunchRate ?? "",
      dinnerRate: active.dinnerRate ?? "",
      cpRate: active.cpRate ?? "",
      mapLunchRate: active.mapLunchRate ?? "",
      mapDinnerRate: active.mapDinnerRate ?? "",
      apRate: active.apRate ?? "",
      currency: active.currency ?? "BTN",
      notes: "",
    });
    setLoadedId(active.id);
  }, [active, loadedId]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveHouseTariff(session!, {
        extraBedRate: num(form.extraBedRate),
        breakfastRate: num(form.breakfastRate),
        lunchRate: num(form.lunchRate),
        dinnerRate: num(form.dinnerRate),
        cpRate: num(form.cpRate),
        mapLunchRate: num(form.mapLunchRate),
        mapDinnerRate: num(form.mapDinnerRate),
        apRate: num(form.apRate),
        currency: form.currency || "BTN",
        notes: form.notes.trim() || null,
      }),
    onSuccess: (row) => {
      toast.success("House tariff saved as a new version");
      setLoadedId(row.id);
      setForm((f) => ({ ...f, notes: "" }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "house-tariff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  /**
   * What each plan will ACTUALLY charge per guest per night, mirroring the backend rule: a
   * configured plan rate wins; otherwise the plan falls back to summing the meals it covers.
   */
  const effective = useMemo(() => {
    const bf = num(form.breakfastRate) ?? 0;
    const ln = num(form.lunchRate) ?? 0;
    const dn = num(form.dinnerRate) ?? 0;
    const pick = (configured: number | null, sum: number) => ({
      value: configured ?? sum,
      derived: configured == null,
    });
    return {
      CP: { ...pick(num(form.cpRate), bf), covers: "breakfast" },
      MAPL: { ...pick(num(form.mapLunchRate), bf + ln), covers: "breakfast + lunch" },
      MAPD: { ...pick(num(form.mapDinnerRate), bf + dn), covers: "breakfast + dinner" },
      AP: { ...pick(num(form.apRate), bf + ln + dn), covers: "breakfast + lunch + dinner" },
    };
  }, [form]);

  if (!session || session.actorLevel !== "L4") return null;

  const versions = versionsQuery.data?.versions ?? [];
  const history = versions.filter((v) => v.id !== active?.id);

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Rates and limits</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          House tariff
          <Help label="House tariff">The hotel's own prices for an extra bed and meals. They apply to any booking with no travel agent or company. Those bookings use their rate package instead and never fall back to these. Room rates are not here: they are on Rate plans, one per room type, with the floor, the season and the discounts. Leave a box empty to mean not priced; an empty meal plan falls back to the sum of its meals. Enter 0 to mean deliberately free, which is not the same as leaving it empty.</Help>
        </h1>
      </div>

      {activeQuery.isLoading && <p className="admin-muted text-sm">Loading…</p>}
      {!activeQuery.isLoading && !active && (
        <div className="admin-panel border-l-4 border-amber-500 p-4 text-sm">
          <strong>No tariff configured yet.</strong> Until one is saved, every extra bed and every meal on a
          walk-in booking is priced at zero.
        </div>
      )}

      <section className="space-y-3">
        <h2 className="admin-display flex items-center gap-2 text-lg">
          Extra bed &amp; à-la-carte meals
          <Help label="Extra bed and meals">Per guest, per serving, per night. These are also the fallback prices for meal plans.</Help>
        </h2>
        <div className="admin-panel grid gap-4 p-5 md:grid-cols-4">
          <RateInput label="Extra bed" hint="per bed, per night" value={form.extraBedRate} onChange={(v) => setForm({ ...form, extraBedRate: v })} />
          <RateInput label="Breakfast" value={form.breakfastRate} onChange={(v) => setForm({ ...form, breakfastRate: v })} />
          <RateInput label="Lunch" value={form.lunchRate} onChange={(v) => setForm({ ...form, lunchRate: v })} />
          <RateInput label="Dinner" value={form.dinnerRate} onChange={(v) => setForm({ ...form, dinnerRate: v })} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="admin-display flex items-center gap-2 text-lg">
          Meal plans
          <Help label="Meal plans">
            A guest on a plan is charged the plan price instead of the individual meals it covers, never both. Leave empty and the plan simply adds up
            its own meals. The desk can still renegotiate any meal price per room at Negotiation: a negotiated meal re-prices only the plans that include
            it, so negotiating dinner moves MAP+D and AP and leaves CP alone.
          </Help>
        </h2>
        <div className="admin-panel grid gap-4 p-5 md:grid-cols-4">
          <RateInput label="CP" hint="breakfast only" value={form.cpRate} onChange={(v) => setForm({ ...form, cpRate: v })} />
          <RateInput label="MAP+L" hint="breakfast + lunch" value={form.mapLunchRate} onChange={(v) => setForm({ ...form, mapLunchRate: v })} />
          <RateInput label="MAP+D" hint="breakfast + dinner" value={form.mapDinnerRate} onChange={(v) => setForm({ ...form, mapDinnerRate: v })} />
          <RateInput label="AP" hint="all three meals" value={form.apRate} onChange={(v) => setForm({ ...form, apRate: v })} />
        </div>

        <div className="admin-panel p-4">
          <p className="admin-eyebrow mb-3">What each plan will charge, per guest per night</p>
          <table className="admin-table">
            <thead>
              <tr><th>Plan</th><th>Covers</th><th>Charged</th><th>Source</th></tr>
            </thead>
            <tbody>
              {(["CP", "MAPL", "MAPD", "AP"] as const).map((k) => (
                <tr key={k}>
                  <td className="text-xs">{k === "MAPL" ? "MAP+L" : k === "MAPD" ? "MAP+D" : k}</td>
                  <td className="admin-muted text-xs">{effective[k].covers}</td>
                  <td className="font-mono">{money(effective[k].value, form.currency)}</td>
                  <td className="text-xs">
                    {effective[k].derived
                      ? <span className="admin-tag">added up from meals</span>
                      : <span className="admin-tag admin-tag-ok">set explicitly</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div className="admin-panel grid gap-4 p-5 md:grid-cols-3">
          <label className="admin-muted text-xs">
            Currency
            <input className="admin-input mt-1" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          </label>
          <label className="admin-muted col-span-2 text-xs">
            Note for the audit trail <span className="opacity-60">(optional)</span>
            <input className="admin-input mt-1" placeholder="e.g. 2026 meal price revision" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="col-span-full flex items-center gap-2">
            <button
              type="button"
              className="admin-btn w-fit"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Saving…" : "Save as new version"}
            </button>
            <Help label="Saving">
              Saving never overwrites. The current tariff is closed off and a new version starts now, so quotes made under the old prices can always be worked
              out.
            </Help>
          </div>
        </div>
      </section>

      {active && (
        <section className="space-y-3">
          <h2 className="admin-display text-lg">Currently active</h2>
          <div className="admin-panel overflow-x-auto p-4">
            <table className="admin-table">
              <thead>
                <tr><th>Extra bed</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th><th>CP</th><th>MAP+L</th><th>MAP+D</th><th>AP</th><th>In force since</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-mono">{money(active.extraBedRate, active.currency)}</td>
                  <td className="font-mono">{money(active.breakfastRate, active.currency)}</td>
                  <td className="font-mono">{money(active.lunchRate, active.currency)}</td>
                  <td className="font-mono">{money(active.dinnerRate, active.currency)}</td>
                  <td className="font-mono">{money(active.cpRate, active.currency)}</td>
                  <td className="font-mono">{money(active.mapLunchRate, active.currency)}</td>
                  <td className="font-mono">{money(active.mapDinnerRate, active.currency)}</td>
                  <td className="font-mono">{money(active.apRate, active.currency)}</td>
                  <td className="font-mono text-xs">{active.effectiveFrom.slice(0, 10)}</td>
                </tr>
              </tbody>
            </table>
            {active.notes && <p className="admin-muted mt-3 text-xs">{active.notes}</p>}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="space-y-3">
          <h2 className="admin-display text-lg">Previous versions</h2>
          <div className="admin-panel overflow-x-auto p-4">
            <table className="admin-table">
              <thead>
                <tr><th>From</th><th>To</th><th>Extra bed</th><th>B / L / D</th><th>CP / MAP+L / MAP+D / AP</th><th>By</th></tr>
              </thead>
              <tbody>
                {history.map((v: HouseTariffAdmin) => (
                  <tr key={v.id}>
                    <td className="font-mono text-xs">{v.effectiveFrom.slice(0, 10)}</td>
                    <td className="font-mono text-xs">{v.effectiveTo ? v.effectiveTo.slice(0, 10) : "—"}</td>
                    <td className="font-mono text-xs">{money(v.extraBedRate, v.currency)}</td>
                    <td className="font-mono text-xs">
                      {[v.breakfastRate, v.lunchRate, v.dinnerRate].map((x) => (x == null ? "—" : Number.parseFloat(x).toFixed(2))).join(" / ")}
                    </td>
                    <td className="font-mono text-xs">
                      {[v.cpRate, v.mapLunchRate, v.mapDinnerRate, v.apRate].map((x) => (x == null ? "—" : Number.parseFloat(x).toFixed(2))).join(" / ")}
                    </td>
                    <td className="admin-muted text-xs">{v.createdBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
