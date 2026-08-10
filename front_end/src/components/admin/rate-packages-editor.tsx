"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  listRatePackages,
  retireRatePackage,
  saveRatePackage,
  setDefaultRatePackage,
  type PackageOwner,
  type RatePackageAdmin,
} from "@/lib/api/admin";

/**
 * Negotiated rate packages for one travel agent, one corporate account, or the house.
 *
 * Replaces the old rate-card editor. A party used to have exactly one rate card, so a second
 * negotiated rate meant a second agent row — "Bhutan INC (Season)" beside "Bhutan INC (Off
 * season)". Packages sit under one party, and the operator picks which applies when quoting.
 *
 * Saving a package whose NAME already exists creates a new version and closes the old one, so
 * quotes issued under the previous rates stay re-derivable. Nothing is edited in place.
 */

const BLANK = {
  name: "",
  roomBaseRate: "",
  extraBedRate: "",
  breakfastRate: "",
  lunchRate: "",
  dinnerRate: "",
  cpRate: "",
  mapLunchRate: "",
  mapDinnerRate: "",
  apRate: "",
  cnbPercent: "",
  currency: "BTN",
  notes: "",
  isDefault: false,
};
type Draft = typeof BLANK;

/** Blank stays null — "not negotiated" is different from zero. */
const numOrNull = (v: string) => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
};

function money(v: string | null | undefined, currency = "BTN") {
  if (v == null || v === "") return "—";
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return "—";
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function draftFrom(p: RatePackageAdmin): Draft {
  return {
    name: p.name,
    roomBaseRate: p.roomBaseRate ?? "",
    extraBedRate: p.extraBedRate ?? "",
    breakfastRate: p.breakfastRate ?? "",
    lunchRate: p.lunchRate ?? "",
    dinnerRate: p.dinnerRate ?? "",
    cpRate: p.cpRate ?? "",
    mapLunchRate: p.mapLunchRate ?? "",
    mapDinnerRate: p.mapDinnerRate ?? "",
    apRate: p.apRate ?? "",
    cnbPercent: p.cnbPercent == null ? "" : String(p.cnbPercent),
    currency: p.currency ?? "BTN",
    notes: "",
    isDefault: p.isDefault,
  };
}

function Field({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="admin-muted text-xs">
      {label}
      <input className="admin-input mt-1" type="number" min="0" step="0.01" placeholder="not set" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="mt-1 block text-[10px] leading-snug opacity-70">{hint}</span>}
    </label>
  );
}

export function RatePackagesEditor({ owner, ownerLabel }: { owner: PackageOwner; ownerLabel: string }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);

  const isCommon = !owner.travelAgentId && !owner.corporateAccountId;
  const queryKey = ["admin", "rate-packages", owner.travelAgentId ?? owner.corporateAccountId ?? "COMMON"];

  const query = useQuery({
    queryKey,
    queryFn: () => listRatePackages(session!, owner),
    enabled: !!session && session.actorLevel === "L4",
  });
  const packages = useMemo(() => query.data?.items ?? [], [query.data]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  const saveM = useMutation({
    mutationFn: () =>
      saveRatePackage(session!, {
        ...owner,
        name: draft.name.trim(),
        roomBaseRate: numOrNull(draft.roomBaseRate) ?? 0,
        extraBedRate: numOrNull(draft.extraBedRate),
        breakfastRate: numOrNull(draft.breakfastRate),
        lunchRate: numOrNull(draft.lunchRate),
        dinnerRate: numOrNull(draft.dinnerRate),
        cpRate: numOrNull(draft.cpRate),
        mapLunchRate: numOrNull(draft.mapLunchRate),
        mapDinnerRate: numOrNull(draft.mapDinnerRate),
        apRate: numOrNull(draft.apRate),
        cnbPercent: draft.cnbPercent.trim() === "" ? null : Number.parseInt(draft.cnbPercent, 10),
        currency: draft.currency || "BTN",
        isDefault: draft.isDefault,
        notes: draft.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success(editing ? `"${draft.name}" saved as a new version` : `Package "${draft.name}" created`);
      setDraft(BLANK);
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const defaultM = useMutation({
    mutationFn: (id: string) => setDefaultRatePackage(session!, id),
    onSuccess: () => { toast.success("Default package updated"); refresh(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not set default"),
  });

  const retireM = useMutation({
    mutationFn: (id: string) => retireRatePackage(session!, id),
    onSuccess: () => { toast.success("Package retired"); refresh(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not retire"),
  });

  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-4">
      <div className="admin-panel p-4 text-xs leading-relaxed">
        <p className="admin-muted">
          {isCommon ? (
            <>
              The <strong>common package</strong> is used when a travel agent or corporate account has no package of
              its own — so a newly-signed agency can be quoted straight away. It never applies to walk-ins, which
              price from rate plans and the house tariff. <strong>One common package is normal.</strong> If you add
              more than one, mark which is the fallback — that is the only one that will actually be used.
            </>
          ) : (
            <>
              Each package is one negotiated rate set for {ownerLabel} — season, off-season, premium, a volume tier.
              The operator picks which applies when quoting; the <strong>default</strong> is preselected.
            </>
          )}
        </p>
        <p className="admin-muted mt-2">
          Saving a package whose name already exists creates a <strong>new version</strong> and closes the old one, so
          quotes issued under the previous rates can still be re-derived. Leave a box empty for &ldquo;not
          negotiated&rdquo; — an empty meal-plan box falls back to the sum of its meals; <strong>0</strong> means
          deliberately free.
        </p>
      </div>

      {query.isLoading && <p className="admin-muted text-sm">Loading packages…</p>}

      {!query.isLoading && packages.length === 0 && (
        <div className="admin-panel border-l-4 border-amber-500 p-4 text-sm">
          {isCommon ? (
            <><strong>No common package.</strong> A party with no package of its own will price at zero until one exists.</>
          ) : (
            <><strong>No packages yet.</strong> {ownerLabel} will fall back to the common package when quoted.</>
          )}
        </div>
      )}

      {packages.length > 0 && (
        <div className="admin-panel overflow-x-auto p-4">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Package</th><th>Room</th><th>Extra bed</th><th>B / L / D</th>
                <th>CP / MAPL / MAPD / AP</th><th>Since</th><th />
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {p.isDefault && <span className="admin-tag admin-tag-ok ml-2">default</span>}
                    {(p.overrides?.length ?? 0) > 0 && (
                      <span className="admin-muted ml-2 text-[10px]">{p.overrides!.length} room-type override(s)</span>
                    )}
                  </td>
                  <td className="font-mono">{money(p.roomBaseRate, p.currency)}</td>
                  <td className="font-mono">{money(p.extraBedRate, p.currency)}</td>
                  <td className="font-mono text-xs">
                    {[p.breakfastRate, p.lunchRate, p.dinnerRate].map((x) => (x == null ? "—" : Number.parseFloat(x).toFixed(2))).join(" / ")}
                  </td>
                  <td className="font-mono text-xs">
                    {[p.cpRate, p.mapLunchRate, p.mapDinnerRate, p.apRate].map((x) => (x == null ? "—" : Number.parseFloat(x).toFixed(2))).join(" / ")}
                  </td>
                  <td className="font-mono text-xs">{p.effectiveFrom.slice(0, 10)}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <button type="button" className="admin-btn text-[10px]" onClick={() => { setDraft(draftFrom(p)); setEditing(p.id); }}>
                        Edit
                      </button>
                      {/* Shown for COMMON too: with more than one common package something has
                          to decide which applies, and leaving it implicit meant the newest
                          silently won. */}
                      {!p.isDefault && (
                        <button type="button" className="admin-btn text-[10px]" disabled={defaultM.isPending} onClick={() => defaultM.mutate(p.id)}>
                          Make default
                        </button>
                      )}
                      <button type="button" className="admin-btn text-[10px]" disabled={retireM.isPending} onClick={() => retireM.mutate(p.id)}>
                        Retire
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-panel space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h3 className="admin-display text-base">{editing ? `Edit "${draft.name}" — saves as a new version` : "Add a package"}</h3>
          {editing && (
            <button type="button" className="admin-btn text-[10px]" onClick={() => { setDraft(BLANK); setEditing(null); }}>
              Cancel
            </button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <label className="admin-muted text-xs">
            Package name
            <input
              className="admin-input mt-1"
              placeholder={isCommon ? "Common agent rate" : "Season / Off season / Premium"}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={!!editing}
            />
            {editing && <span className="mt-1 block text-[10px] opacity-70">Name is fixed — it identifies the version chain.</span>}
          </label>
          <Field label="Room rate" hint="per night, before tax" value={draft.roomBaseRate} onChange={(v) => setDraft({ ...draft, roomBaseRate: v })} />
          <Field label="Extra bed" value={draft.extraBedRate} onChange={(v) => setDraft({ ...draft, extraBedRate: v })} />
          <label className="admin-muted text-xs">
            Currency
            <input className="admin-input mt-1" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
          </label>
        </div>

        <div>
          <p className="admin-eyebrow mb-2">À-la-carte meals</p>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Breakfast" value={draft.breakfastRate} onChange={(v) => setDraft({ ...draft, breakfastRate: v })} />
            <Field label="Lunch" value={draft.lunchRate} onChange={(v) => setDraft({ ...draft, lunchRate: v })} />
            <Field label="Dinner" value={draft.dinnerRate} onChange={(v) => setDraft({ ...draft, dinnerRate: v })} />
            <Field label="CNB %" hint="child-no-bed discount" value={draft.cnbPercent} onChange={(v) => setDraft({ ...draft, cnbPercent: v })} />
          </div>
        </div>

        <div>
          <p className="admin-eyebrow mb-2">Meal plans — charged instead of the meals they cover</p>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="CP" hint="breakfast" value={draft.cpRate} onChange={(v) => setDraft({ ...draft, cpRate: v })} />
            <Field label="MAPL" hint="breakfast + lunch" value={draft.mapLunchRate} onChange={(v) => setDraft({ ...draft, mapLunchRate: v })} />
            <Field label="MAPD" hint="breakfast + dinner" value={draft.mapDinnerRate} onChange={(v) => setDraft({ ...draft, mapDinnerRate: v })} />
            <Field label="AP" hint="all three" value={draft.apRate} onChange={(v) => setDraft({ ...draft, apRate: v })} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="admin-muted col-span-2 text-xs">
            Note for the audit trail <span className="opacity-60">(optional)</span>
            <input className="admin-input mt-1" placeholder="e.g. 2026 season revision" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>
          <label className="admin-muted flex items-center gap-2 self-end text-xs">
            <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
            {isCommon ? "Use this one as the fallback" : "Preselect this package when quoting"}
          </label>
        </div>

        <button
          type="button"
          className="admin-btn w-fit"
          disabled={saveM.isPending || !draft.name.trim() || draft.roomBaseRate.trim() === ""}
          onClick={() => saveM.mutate()}
        >
          {saveM.isPending ? "Saving…" : editing ? "Save as new version" : "Create package"}
        </button>
      </div>
    </div>
  );
}
