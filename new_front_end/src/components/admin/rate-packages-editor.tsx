"use client";

import { AdmField } from "@/components/admin/field-title";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  deletePackageRoomTypeOverride,
  listRatePackages,
  listRoomTypes,
  retireRatePackage,
  saveRatePackage,
  setDefaultRatePackage,
  setPackageRoomTypeOverride,
  type PackageOwner,
  type RatePackageAdmin,
  type RoomTypeAdmin,
  type PackageRatesWorkedOut,
  workOutPackageRates,
} from "@/lib/api/admin";
import { Help } from "@/components/ds/help";

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

const PLAN_KEYS = ["cpRate", "mapLunchRate", "mapDinnerRate", "apRate"] as const;
/** The rates the manager may type with service charge and GST in them. */
const WITH_TAX_FIELDS: Array<{ key: keyof Draft; label: string }> = [
  { key: "roomBaseRate", label: "Room rate" },
  { key: "extraBedRate", label: "Extra bed" },
  { key: "breakfastRate", label: "Breakfast" },
  { key: "lunchRate", label: "Lunch" },
  { key: "dinnerRate", label: "Dinner" },
  { key: "cpRate", label: "CP" },
  { key: "mapLunchRate", label: "MAP+L" },
  { key: "mapDinnerRate", label: "MAP+D" },
  { key: "apRate", label: "AP" },
];
/** "0.1" reads as "10%", to the figure the setting holds. */
const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

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
    <AdmField label={label} hint={hint}>
      <input className="admin-input" type="number" min="0" step="0.01" placeholder="not set" value={value} onChange={(e) => onChange(e.target.value)} />
    </AdmField>
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

  /* ----- per-room-type overrides -----------------------------------------
   * A package carries ONE room rate, but a Suite and a Standard Double rarely
   * negotiate to the same number. An override pins a different room rate for one
   * room type; resolution reports roomRateSource = ROOM_TYPE_OVERRIDE when one applies.
   * Overrides belong to a package VERSION and are carried forward when it is superseded. */
  const [openOverridesFor, setOpenOverridesFor] = useState<string | null>(null);
  const [ovRoomTypeId, setOvRoomTypeId] = useState("");
  const [ovRate, setOvRate] = useState("");
  const [ovWithTax, setOvWithTax] = useState(false);

  /* ----- what the form fills in as it is typed (2026-11-03, operator) ------
   * The meal plans start at the sum of the meals they cover, and stay editable: a plan typed by hand,
   * or already on the package, is left alone. A rate the manager has with service charge and GST in
   * it goes in the box above the fields, and the rate without them lands in the field. Every figure
   * is the server's. */
  const handPicked = useRef(new Set<string>());
  const fromWithTax = useRef(new Set<string>());
  // What each box was last filled from, so a figure corrected by hand survives the next one typed.
  const appliedGross = useRef<Record<string, string>>({});
  const [withTax, setWithTax] = useState(false);
  const [gross, setGross] = useState<Record<string, string>>({});
  const [worked, setWorked] = useState<PackageRatesWorkedOut | null>(null);
  const taxRates = useQuery({
    queryKey: ["admin", "rate-packages", "tax-rates"],
    queryFn: () => workOutPackageRates(session!, {}),
    enabled: !!session && (withTax || ovWithTax),
  });

  const resetExtras = () => {
    handPicked.current = new Set();
    fromWithTax.current = new Set();
    appliedGross.current = {};
    setWithTax(false);
    setGross({});
    setWorked(null);
  };
  const startEdit = (p: RatePackageAdmin) => {
    resetExtras();
    const d = draftFrom(p);
    handPicked.current = new Set(PLAN_KEYS.filter((k) => d[k] !== ""));
    setDraft(d);
    setEditing(p.id);
  };
  const resetForm = () => {
    resetExtras();
    setDraft(BLANK);
    setEditing(null);
  };

  useEffect(() => {
    if (!session) return;
    const meals = { breakfast: numOrNull(draft.breakfastRate), lunch: numOrNull(draft.lunchRate), dinner: numOrNull(draft.dinnerRate) };
    let stale = false;
    const t = window.setTimeout(async () => {
      const r = await workOutPackageRates(session, { meals }).catch(() => null);
      if (stale || !r?.planRates) return;
      const plans = r.planRates;
      setDraft((d) => {
        const next = { ...d };
        for (const k of PLAN_KEYS) if (!handPicked.current.has(k)) next[k] = plans[k] ?? "";
        return next;
      });
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.breakfastRate, draft.lunchRate, draft.dinnerRate]);

  useEffect(() => {
    if (!session || !withTax) return;
    const typed: Record<string, number> = {};
    for (const [k, v] of Object.entries(gross)) {
      const n = numOrNull(v);
      if (n != null && n >= 0) typed[k] = n;
    }
    let stale = false;
    const t = window.setTimeout(async () => {
      const r = Object.keys(typed).length ? await workOutPackageRates(session, { withTaxes: typed }).catch(() => null) : null;
      if (stale) return;
      setWorked(r);
      // Worked out here, not in the update: React runs an update twice in development.
      const emptied = [...fromWithTax.current].filter((k) => !(k in typed));
      for (const k of emptied) {
        fromWithTax.current.delete(k);
        handPicked.current.delete(k);
        delete appliedGross.current[k];
      }
      const filled = Object.entries(r?.withoutTaxes ?? {}).filter(([k]) => appliedGross.current[k] !== String(typed[k]));
      for (const [k] of filled) {
        appliedGross.current[k] = String(typed[k]);
        fromWithTax.current.add(k);
        if ((PLAN_KEYS as readonly string[]).includes(k)) handPicked.current.add(k);
      }
      if (emptied.length || filled.length) {
        setDraft((d) => ({ ...d, ...Object.fromEntries(emptied.map((k) => [k, ""])), ...Object.fromEntries(filled) }));
      }
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gross, withTax]);

  const roomTypesQuery = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled: !!session,
  });
  const roomTypes: RoomTypeAdmin[] = roomTypesQuery.data?.items ?? [];

  const setOverrideM = useMutation({
    mutationFn: async (packageId: string) => {
      const rate = Number.parseFloat(ovRate);
      if (!ovRoomTypeId) throw new Error("Choose a room type");
      if (!Number.isFinite(rate) || rate < 0) throw new Error("Enter a valid room rate");
      const value = ovWithTax ? (await workOutPackageRates(session!, { withTaxes: { override: rate } })).withoutTaxes.override : rate;
      return setPackageRoomTypeOverride(session!, packageId, { roomTypeId: ovRoomTypeId, roomBaseRate: value });
    },
    onSuccess: () => {
      toast.success("Room-type override saved");
      setOvRoomTypeId("");
      setOvRate("");
      setOvWithTax(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "rate-packages"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : (e as Error).message),
  });
  const deleteOverrideM = useMutation({
    mutationFn: (overrideId: string) => deletePackageRoomTypeOverride(session!, overrideId),
    onSuccess: () => {
      toast.success("Override removed");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rate-packages"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not remove the override"),
  });

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
      resetForm();
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
      <p className="admin-eyebrow flex w-fit items-center gap-2">
        Rate packages
        <Help label="Rate packages">
          {isCommon ? (
            <>
              The common package is used when a travel agent or corporate account has no package of its own, so a newly signed agency can be quoted
              straight away. It never applies to walk-ins, which price from rate plans and the house tariff. One common package is normal. If you add more
              than one, mark which is the fallback: that is the only one used.
            </>
          ) : (
            <>
              Each package is one negotiated set of rates for {ownerLabel}: season, off-season, premium, a volume tier. The desk picks which applies when
              quoting, and the default is preselected.
            </>
          )}{" "}
          Saving a package whose name already exists makes a new version and closes the old one, so quotes made under the earlier rates can still be worked
          out. Leave a box empty for "not negotiated". An empty meal plan falls back to the sum of its meals; 0 means deliberately free.
        </Help>
      </p>

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
                <th>CP / MAP+L / MAP+D / AP</th><th>Since</th><th />
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <Fragment key={p.id}>
                <tr>
                  <td>
                    {p.name}
                    {p.isDefault && <span className="admin-tag admin-tag-ok ml-2">default</span>}
                    <button
                      type="button"
                      className="admin-muted ml-2 text-[10px] underline"
                      onClick={() => setOpenOverridesFor(openOverridesFor === p.id ? null : p.id)}
                    >
                      {(p.overrides?.length ?? 0) > 0
                        ? `${p.overrides!.length} room-type override(s)`
                        : "add room-type override"}
                    </button>
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
                      <button type="button" className="admin-btn text-[10px]" onClick={() => startEdit(p)}>
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
                {openOverridesFor === p.id && (
                  <tr>
                    <td colSpan={7} className="bg-black/[0.02] p-3">
                      <div className="admin-muted mb-2 text-[11px]">
                        Per-room-type room rate for <strong>{p.name}</strong>. A Suite and a Standard Double rarely
                        negotiate to the same number; without an override every room type is quoted at the
                        package&rsquo;s single room rate.
                      </div>
                      {(p.overrides?.length ?? 0) > 0 ? (
                        <table className="admin-table mb-3">
                          <thead><tr><th>Room type</th><th>Room rate</th><th /></tr></thead>
                          <tbody>
                            {p.overrides!.map((o) => (
                              <tr key={o.id}>
                                <td>{roomTypes.find((rt) => rt.id === o.roomTypeId)?.name ?? o.roomTypeId}</td>
                                <td className="font-mono">{money(o.roomBaseRate, p.currency)}</td>
                                <td className="text-right">
                                  <button
                                    type="button"
                                    className="admin-btn text-[10px]"
                                    disabled={deleteOverrideM.isPending}
                                    onClick={() => deleteOverrideM.mutate(o.id)}
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="admin-muted mb-3 text-[11px]">No overrides — every room type uses {money(p.roomBaseRate, p.currency)}.</div>
                      )}
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="admin-muted text-xs">
                          Room type
                          <select className="admin-input mt-1" value={ovRoomTypeId} onChange={(e) => setOvRoomTypeId(e.target.value)}>
                            <option value="">Select…</option>
                            {roomTypes.map((rt) => (
                              <option key={rt.id} value={rt.id}>{rt.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="admin-muted text-xs">
                          {ovWithTax ? "Room rate with service charge and GST" : "Room rate"}
                          <input className="admin-input mt-1" inputMode="decimal" value={ovRate} onChange={(e) => setOvRate(e.target.value)} />
                        </label>
                        <label className="adm-tick">
                          <input type="checkbox" checked={ovWithTax} onChange={(e) => setOvWithTax(e.target.checked)} />
                          It has service charge and GST in it
                        </label>
                        <button
                          type="button"
                          className="admin-btn"
                          disabled={setOverrideM.isPending}
                          onClick={() => setOverrideM.mutate(p.id)}
                        >
                          {p.overrides?.some((o) => o.roomTypeId === ovRoomTypeId) ? "Replace override" : "Add override"}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="admin-panel space-y-4 p-5" data-edit-form>
        <div className="flex items-center justify-between">
          <h3 className="admin-display text-base">{editing ? `Edit "${draft.name}" — saves as a new version` : "Add a package"}</h3>
          {editing && (
            <button type="button" className="admin-btn text-[10px]" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>

        <div className="adm-with-tax">
          <div className="adm-with-tax-head">
            <label className="adm-tick">
              <input
                type="checkbox"
                checked={withTax}
                onChange={(e) => {
                  setWithTax(e.target.checked);
                  if (!e.target.checked) {
                    setGross({});
                    setWorked(null);
                    fromWithTax.current = new Set();
                    appliedGross.current = {};
                  }
                }}
              />
              I have these rates with service charge and GST in them
            </label>
            <Help label="Rates with service charge and GST">
              Type each rate as you have it, with service charge and GST in it. The rate without them goes into the box of the same name below, which is
              what the package saves and what the bill adds them to. You can still change those boxes.
            </Help>
          </div>
          {withTax ? (
            <>
              <p className="adm-with-tax-rates">
                {taxRates.data
                  ? `Service charge ${percent(taxRates.data.serviceChargeRate)}, then GST ${percent(taxRates.data.gstRate)} on the two, are taken out.`
                  : "Reading the service charge and GST…"}
              </p>
              <div className="adm-with-tax-grid">
                {WITH_TAX_FIELDS.map(({ key, label }) => {
                  const typed = gross[key] ?? "";
                  const net = worked?.withoutTaxes[key];
                  const back = worked?.comesTo[key];
                  const off = !!back && typed !== "" && Number(back) !== Number(typed);
                  return (
                    <label key={key} className="admin-muted text-xs">
                      {label}
                      <input
                        className="admin-input mt-1"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="with both"
                        aria-label={`${label} with service charge and GST`}
                        value={typed}
                        onChange={(e) => setGross((g) => ({ ...g, [key]: e.target.value }))}
                      />
                      {net && typed !== "" ? (
                        <span className="adm-with-tax-net">
                          {money(net, draft.currency)} without them
                          {off ? <b className="warn-ink"> · comes to {money(back, draft.currency)}</b> : null}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </>
          ) : null}
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
          <p className="admin-eyebrow mb-2">
            Meal plans — charged instead of the meals they cover
            <Help label="Meal plan rates">They start at the sum of the meals above. Type over any of them: a figure you type stays as you typed it.</Help>
          </p>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="CP" hint="breakfast" value={draft.cpRate} onChange={(v) => { handPicked.current.add("cpRate"); setDraft({ ...draft, cpRate: v }); }} />
            <Field label="MAP+L" hint="breakfast + lunch" value={draft.mapLunchRate} onChange={(v) => { handPicked.current.add("mapLunchRate"); setDraft({ ...draft, mapLunchRate: v }); }} />
            <Field label="MAP+D" hint="breakfast + dinner" value={draft.mapDinnerRate} onChange={(v) => { handPicked.current.add("mapDinnerRate"); setDraft({ ...draft, mapDinnerRate: v }); }} />
            <Field label="AP" hint="all three" value={draft.apRate} onChange={(v) => { handPicked.current.add("apRate"); setDraft({ ...draft, apRate: v }); }} />
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
