"use client";

/**
 * Apartments — the hotel's service apartments, let by the week or the month (2026-11-25, operator,
 * from "Service Apartment Rates - 2026": "add apartment section under rates and limits … premium suite
 * would be the name of the package and under that admin will choose the rooms that fall under it, and
 * also the max occupant for each room, and some details like amenities and carpet area, and then
 * rates … inclusive of gst and service charge").
 *
 * A package holds its apartments; an apartment is one room, or several rooms let together (the 2 BHK
 * "505" is rooms 5051 + 5052). Rates are kept without service charge and GST; the figures typed with
 * both are worked out by the server, which also says what the guest is billed (`work-out`) — nothing
 * is added up here.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AdmField, FieldTitle } from "@/components/admin/field-title";
import { Help } from "@/components/ds/help";
import { useConfirm } from "@/components/providers/dialog-provider";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  createApartmentPackage,
  deleteApartmentPackage,
  listApartmentPackagesAdmin,
  setApartmentPackageActive,
  updateApartmentPackage,
  workOutApartmentRates,
  type ApartmentPackageView,
  type ApartmentRateFigures,
  type ApartmentRoomOption,
} from "@/lib/api/admin";

const KEY = ["admin", "apartment-packages"];

function nu(v: string | null | undefined) {
  if (v == null || v === "") return "—";
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? `Nu ${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
}

const BED_WORD: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };

type UnitDraft = { key: string; label: string; maxOccupants: string; roomIds: string[] };
type Draft = {
  name: string;
  carpetAreaSqft: string;
  amenities: string;
  ratesWithTaxes: boolean;
  weeklyRate: string;
  monthlyRate: string;
  sortOrder: string;
  units: UnitDraft[];
};

let unitSeq = 0;
const newUnit = (): UnitDraft => ({ key: `u${++unitSeq}`, label: "", maxOccupants: "3", roomIds: [] });

function draftOf(p: ApartmentPackageView | null): Draft {
  if (!p) return { name: "", carpetAreaSqft: "", amenities: "", ratesWithTaxes: true, weeklyRate: "", monthlyRate: "", sortOrder: "", units: [newUnit()] };
  const typed = p.ratesTypedWithTax;
  return {
    name: p.name,
    carpetAreaSqft: p.carpetAreaSqft == null ? "" : String(p.carpetAreaSqft),
    amenities: p.amenities ?? "",
    ratesWithTaxes: typed,
    weeklyRate: typed ? (p.weekly.typed ?? p.weekly.total) : p.weekly.rate,
    monthlyRate: typed ? (p.monthly.typed ?? p.monthly.total) : p.monthly.rate,
    sortOrder: String(p.sortOrder),
    units: p.units.map((u) => ({ key: `u${++unitSeq}`, label: u.label, maxOccupants: String(u.maxOccupants), roomIds: u.rooms.map((r) => r.roomId) })),
  };
}

/** A rate as the bill reads it, from the server. */
function RateLine({ label, f, typedWithTax }: { label: string; f: ApartmentRateFigures | null; typedWithTax: boolean }) {
  if (!f) return null;
  return (
    <tr>
      <td>
        <strong>{label}</strong>
      </td>
      <td className="font-mono">{nu(f.rate)}</td>
      <td className="font-mono">{nu(f.serviceCharge)}</td>
      <td className="font-mono">{nu(f.gst)}</td>
      <td className="font-mono">
        <strong>{nu(f.total)}</strong>
        {typedWithTax && f.typed && f.typed !== f.total ? <span className="apt-typed"> typed {nu(f.typed)}</span> : null}
      </td>
    </tr>
  );
}

function RatesTable({ weekly, monthly, typedWithTax }: { weekly: ApartmentRateFigures | null; monthly: ApartmentRateFigures | null; typedWithTax: boolean }) {
  if (!weekly && !monthly) return null;
  return (
    <table className="admin-table apt-rates">
      <thead>
        <tr>
          <th />
          <th>Rate</th>
          <th>Service charge</th>
          <th>GST</th>
          <th>
            <span className="flex items-center gap-1">
              The guest pays
              <Help label="The guest pays">
                The rate with its service charge, and GST on the two, each worked out to the chhertum as a line on the bill. A figure typed with service charge
                and GST in it can come back a chhertum short; the figure typed is shown beside it.
              </Help>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <RateLine label="A week" f={weekly} typedWithTax={typedWithTax} />
        <RateLine label="A month" f={monthly} typedWithTax={typedWithTax} />
      </tbody>
    </table>
  );
}

function roomWords(r: { roomNumber: string; roomTypeName: string; bedType: string | null }) {
  return `${r.roomNumber} · ${r.roomTypeName}${r.bedType ? ` · ${BED_WORD[r.bedType] ?? r.bedType}` : ""}`;
}

function PackageCard({
  p,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: {
  p: ApartmentPackageView;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <div className={`admin-panel apt-card${p.isActive ? "" : " apt-off"}`}>
      <div className="apt-head">
        <div>
          <h2 className="admin-display text-lg">{p.name}</h2>
          <p className="admin-muted text-sm">
            {p.carpetAreaSqft ? `${p.carpetAreaSqft.toLocaleString("en-GB")} sq ft · ` : ""}
            {p.units.length === 1 ? "1 apartment" : `${p.units.length} apartments`}
            {p.isActive ? "" : " · not offered"}
          </p>
        </div>
        <div className="apt-acts">
          <button type="button" className="admin-btn admin-btn-ghost" onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button type="button" className="admin-btn admin-btn-ghost" onClick={onToggle} disabled={busy}>
            {p.isActive ? "Stop offering" : "Offer again"}
          </button>
          <button type="button" className="admin-btn admin-btn-ghost apt-del" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
      <div className="apt-units">
        {p.units.length ? (
          p.units.map((u) => (
            <span key={u.id} className="apt-unit">
              <b>{u.label}</b>
              {u.rooms.length > 1 || u.rooms[0]?.roomNumber !== u.label ? (
                <span>{u.rooms.length > 1 ? `Rooms ${u.rooms.map((r) => r.roomNumber).join(" + ")}` : `Room ${u.rooms[0]?.roomNumber ?? "—"}`}</span>
              ) : null}
              <span>up to {u.maxOccupants} guests</span>
            </span>
          ))
        ) : (
          <span className="admin-tag admin-tag-warn">No apartments yet</span>
        )}
      </div>
      <RatesTable weekly={p.weekly} monthly={p.monthly} typedWithTax={p.ratesTypedWithTax} />
      {p.amenities ? (
        <details className="apt-amenities">
          <summary>Amenities</summary>
          <ul>
            {p.amenities.split("\n").filter(Boolean).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PackageForm({
  initial,
  rooms,
  onCancel,
  onSaved,
}: {
  initial: ApartmentPackageView | null;
  rooms: ApartmentRoomOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { session } = useSession();
  const [d, setD] = useState<Draft>(() => draftOf(initial));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setUnit = (key: string, patch: Partial<UnitDraft>) => setD((x) => ({ ...x, units: x.units.map((u) => (u.key === key ? { ...u, ...patch } : u)) }));

  // The rates worked out by the server as they are typed: what is kept and what the guest pays.
  const [typed, setTyped] = useState({ weekly: d.weeklyRate, monthly: d.monthlyRate, withTaxes: d.ratesWithTaxes });
  useEffect(() => {
    const t = setTimeout(() => setTyped({ weekly: d.weeklyRate, monthly: d.monthlyRate, withTaxes: d.ratesWithTaxes }), 300);
    return () => clearTimeout(t);
  }, [d.weeklyRate, d.monthlyRate, d.ratesWithTaxes]);
  const workOut = useQuery({
    queryKey: ["admin", "apartment-work-out", typed],
    queryFn: () => workOutApartmentRates(session!, typed),
    enabled: !!session && !!(typed.weekly.trim() || typed.monthly.trim()),
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: d.name,
        carpetAreaSqft: d.carpetAreaSqft.trim() ? Number(d.carpetAreaSqft) : null,
        amenities: d.amenities.trim() || null,
        ratesWithTaxes: d.ratesWithTaxes,
        weeklyRate: d.weeklyRate.trim(),
        monthlyRate: d.monthlyRate.trim(),
        sortOrder: d.sortOrder.trim() ? Number(d.sortOrder) : null,
        units: d.units.map((u) => ({ label: u.label, maxOccupants: Number(u.maxOccupants), roomIds: u.roomIds })),
      };
      return initial ? updateApartmentPackage(session!, initial.id, body) : createApartmentPackage(session!, body);
    },
    onSuccess: (p) => {
      toast.success(initial ? `${p.name} is saved` : `${p.name} is added`);
      onSaved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Not saved"),
  });

  const takenHere = new Map<string, string>();
  for (const u of d.units) for (const r of u.roomIds) takenHere.set(r, u.label || "another apartment");
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const why = !d.name.trim()
    ? "Give the package a name"
    : !d.weeklyRate.trim() || !d.monthlyRate.trim()
      ? "Type both rates"
      : d.units.some((u) => !u.label.trim())
        ? "Give every apartment its number"
        : d.units.some((u) => !u.roomIds.length)
          ? `Pick the room of apartment ${d.units.find((u) => !u.roomIds.length)?.label || "…"}`
          : null;

  const wk = workOut.data?.weekly ?? null;
  const mo = workOut.data?.monthly ?? null;

  return (
    <div className="admin-panel apt-form" data-edit-form>
      <h2 className="admin-display text-lg">{initial ? `Edit ${initial.name}` : "A new apartment package"}</h2>
      <div className="grid gap-4 md:grid-cols-4">
        <AdmField label="Name" className="md:col-span-2" required>
          <input className="admin-input" value={d.name} placeholder="Premium Suite" onChange={(e) => set("name", e.target.value)} />
        </AdmField>
        <AdmField label="Carpet area" hint="square feet">
          <input className="admin-input" inputMode="numeric" value={d.carpetAreaSqft} onChange={(e) => set("carpetAreaSqft", e.target.value.replace(/\D/g, ""))} />
        </AdmField>
        <AdmField label="Order" hint="first on the list" help="Packages are listed by this number, then by name.">
          <input className="admin-input" inputMode="numeric" value={d.sortOrder} onChange={(e) => set("sortOrder", e.target.value.replace(/\D/g, ""))} />
        </AdmField>
      </div>

      <AdmField label="Amenities" hint="one on each line">
        <textarea className="admin-input" rows={5} value={d.amenities} onChange={(e) => set("amenities", e.target.value)} />
      </AdmField>

      <div className="apt-section">
        <FieldTitle label="Rates" help="A week is seven nights. A month runs from the check-in date to the same date the month after. The rates are kept without service charge and GST, as every rate is." />
        <label className="apt-tick">
          <input type="checkbox" checked={d.ratesWithTaxes} onChange={(e) => set("ratesWithTaxes", e.target.checked)} />
          I have these rates with service charge and GST in them
        </label>
        <div className="grid gap-4 md:grid-cols-4">
          <AdmField label={d.ratesWithTaxes ? "A week, with service charge and GST" : "A week"} required>
            <input className="admin-input" inputMode="decimal" value={d.weeklyRate} onChange={(e) => set("weeklyRate", e.target.value.replace(/[^\d.,]/g, ""))} />
          </AdmField>
          <AdmField label={d.ratesWithTaxes ? "A month, with service charge and GST" : "A month"} required>
            <input className="admin-input" inputMode="decimal" value={d.monthlyRate} onChange={(e) => set("monthlyRate", e.target.value.replace(/[^\d.,]/g, ""))} />
          </AdmField>
        </div>
        {wk || mo ? <RatesTable weekly={wk} monthly={mo} typedWithTax={d.ratesWithTaxes} /> : null}
      </div>

      <div className="apt-section">
        <FieldTitle label="Apartments" help="Each apartment the hotel lets under this package: its number, its room, and the most guests it takes. Rooms let together, like a 2 BHK's two bedrooms, are one apartment with several rooms." />
        <table className="admin-table apt-unit-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Rooms</th>
              <th>Most guests</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.units.map((u) => (
              <tr key={u.key}>
                <td>
                  <input className="admin-input apt-label" aria-label="Apartment number" value={u.label} placeholder="503" onChange={(e) => setUnit(u.key, { label: e.target.value })} />
                </td>
                <td>
                  <div className="apt-rooms">
                    {u.roomIds.map((id) => {
                      const r = roomById.get(id);
                      return (
                        <span key={id} className="apt-room">
                          {r ? roomWords(r) : id}
                          <button type="button" aria-label={`Take room ${r?.roomNumber ?? id} off`} onClick={() => setUnit(u.key, { roomIds: u.roomIds.filter((x) => x !== id) })}>
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <select
                      className="admin-input admin-select apt-add-room"
                      aria-label="Add a room"
                      value=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        setUnit(u.key, {
                          roomIds: [...u.roomIds, id],
                          label: u.label || (u.roomIds.length === 0 ? (roomById.get(id)?.roomNumber ?? "") : u.label),
                        });
                      }}
                    >
                      <option value="">{u.roomIds.length ? "Add another room…" : "Pick the room…"}</option>
                      {rooms.map((r) => {
                        const here = takenHere.get(r.id);
                        const elsewhere = r.apartment && r.apartment.packageId !== initial?.id ? r.apartment : null;
                        const shut = !!here || !!elsewhere;
                        return (
                          <option key={r.id} value={r.id} disabled={shut}>
                            {roomWords(r)}
                            {here ? ` · in apartment ${here}` : elsewhere ? ` · in ${elsewhere.label}, ${elsewhere.packageName}` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </td>
                <td>
                  <input
                    className="admin-input apt-max"
                    aria-label="Most guests"
                    inputMode="numeric"
                    value={u.maxOccupants}
                    onChange={(e) => setUnit(u.key, { maxOccupants: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="admin-btn admin-btn-ghost"
                    onClick={() => setD((x) => ({ ...x, units: x.units.filter((v) => v.key !== u.key) }))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="admin-btn admin-btn-ghost w-fit" onClick={() => setD((x) => ({ ...x, units: [...x.units, newUnit()] }))}>
          Add an apartment
        </button>
      </div>

      <div className="apt-save">
        {why ? <span className="admin-muted text-sm">{why}</span> : null}
        <button type="button" className="admin-btn admin-btn-ghost" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
        <button type="button" className="admin-btn" disabled={!!why || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : initial ? "Save the package" : "Add the package"}
        </button>
      </div>
    </div>
  );
}

export default function AdminApartmentsPage() {
  const { session } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const enabled = !!session && session.actorLevel === "L4";
  const q = useQuery({ queryKey: KEY, queryFn: () => listApartmentPackagesAdmin(session!), enabled });
  const [editing, setEditing] = useState<string | "new" | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const toggle = useMutation({
    mutationFn: (p: ApartmentPackageView) => setApartmentPackageActive(session!, p.id, !p.isActive),
    onSuccess: (p) => {
      toast.success(p.isActive ? `${p.name} is offered again` : `${p.name} is no longer offered`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Not changed"),
  });
  const remove = useMutation({
    mutationFn: (p: ApartmentPackageView) => deleteApartmentPackage(session!, p.id),
    onSuccess: () => {
      toast.success("The package is deleted");
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Not deleted"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const data = q.data;
  const packages = data?.packages ?? [];
  const rooms = data?.rooms ?? [];
  const editingPkg = editing && editing !== "new" ? (packages.find((p) => p.id === editing) ?? null) : null;

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="admin-eyebrow mb-2">Rates and limits</p>
          <h1 className="admin-display flex items-center gap-2 text-3xl">
            Apartments
            <Help label="Apartments">
              The hotel&rsquo;s service apartments, let by the week or the month. Each package names the apartments that fall under it, the most guests each
              takes, and its two rates. A room belongs to one apartment at most.
            </Help>
          </h1>
        </div>
        {editing !== "new" ? (
          <button type="button" className="admin-btn" onClick={() => setEditing("new")}>
            Add a package
          </button>
        ) : null}
      </div>

      {q.isLoading ? <p className="admin-muted text-sm">Loading…</p> : null}
      {q.isError ? <p className="text-sm text-red-700">{q.error instanceof ApiError ? q.error.message : "Could not load the apartments"}</p> : null}
      {data && !packages.length && editing !== "new" ? (
        <div className="admin-panel p-4 text-sm">No apartment packages yet.</div>
      ) : null}

      {editing === "new" ? (
        <PackageForm
          initial={null}
          rooms={rooms}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}

      {packages.map((p) =>
        editing === p.id && editingPkg ? (
          <PackageForm
            key={p.id}
            initial={editingPkg}
            rooms={rooms}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              refresh();
            }}
          />
        ) : (
          <PackageCard
            key={p.id}
            p={p}
            busy={toggle.isPending || remove.isPending}
            onEdit={() => setEditing(p.id)}
            onToggle={async () => {
              const ok = await confirm({
                title: p.isActive ? `Stop offering ${p.name}?` : `Offer ${p.name} again?`,
                message: p.isActive
                  ? "It stays on this page with its apartments and rates, and the desk no longer offers it."
                  : "The desk offers it again.",
                confirmLabel: p.isActive ? "Stop offering" : "Offer again",
                variant: p.isActive ? "danger" : "default",
              });
              if (ok) toggle.mutate(p);
            }}
            onDelete={async () => {
              const ok = await confirm({
                title: `Delete ${p.name}?`,
                message: "The package and its apartments are taken off. The rooms stay rooms. This cannot be undone; the audit trail keeps what it was.",
                confirmLabel: "Delete",
                variant: "danger",
              });
              if (ok) remove.mutate(p);
            }}
          />
        ),
      )}
    </div>
  );
}
