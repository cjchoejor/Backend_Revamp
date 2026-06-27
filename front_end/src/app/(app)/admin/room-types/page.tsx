"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createRoomType, deleteRoomType, listRoomTypes, updateRoomType, type RoomTypeAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

type CreateForm = {
  code: string;
  name: string;
  maxOccupancy: string;
  maxChildren: string;
  requiredAccompanyingAdults: string;
  maxExtraBeds: string;
};

const EMPTY_CREATE: CreateForm = {
  code: "",
  name: "",
  maxOccupancy: "2",
  maxChildren: "2",
  requiredAccompanyingAdults: "1",
  maxExtraBeds: "0",
};

export default function AdminRoomTypesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE);
  const [editing, setEditing] = useState<Record<string, RoomTypeAdmin>>({});

  const query = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createRoomType(session!, {
        code: form.code.trim(),
        name: form.name.trim(),
        maxOccupancy: numOr(form.maxOccupancy, 2),
        maxChildren: numOr(form.maxChildren, 2),
        requiredAccompanyingAdults: numOr(form.requiredAccompanyingAdults, 1),
        maxExtraBeds: numOr(form.maxExtraBeds, 0),
      }),
    onSuccess: () => {
      toast.success("Room type created");
      setForm(EMPTY_CREATE);
      void queryClient.invalidateQueries({ queryKey: ["admin", "room-types"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; body: Partial<RoomTypeAdmin> }) => updateRoomType(session!, vars.id, vars.body),
    onSuccess: () => {
      toast.success("Room type updated");
      setEditing({});
      void queryClient.invalidateQueries({ queryKey: ["admin", "room-types"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRoomType(session!, id),
    onSuccess: () => {
      toast.success("Room type deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin", "room-types"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  const items = query.data?.items ?? [];

  async function handleDelete(id: string, code: string, roomCount: number) {
    if (roomCount > 0) {
      toast.error("Remove or reassign all rooms of this type before deleting");
      return;
    }
    const ok = await confirm({
      title: "Delete room type",
      message: `Delete "${code}" permanently? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    deleteMutation.mutate(id);
  }

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 02 · Inventory</p>
        <h1 className="admin-display text-3xl">Room types</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-type physical capacity limits. The booking flow enforces these at S1 intake (over-capacity =
          block) and the calendar grid respects them for filtering.
        </p>
      </div>

      <div className="admin-panel space-y-4 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">New room type</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Code" hint="Short code, e.g. DLX">
            <input className="admin-input" placeholder="DLX" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label="Name" hint="Display name">
            <input className="admin-input" placeholder="Deluxe Room" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Max occupancy" hint="Total guests (A + C)">
            <input className="admin-input" type="number" min={1} value={form.maxOccupancy} onChange={(e) => setForm({ ...form, maxOccupancy: e.target.value })} />
          </Field>
          <Field label="Max children" hint="Cap on minors">
            <input className="admin-input" type="number" min={0} value={form.maxChildren} onChange={(e) => setForm({ ...form, maxChildren: e.target.value })} />
          </Field>
          <Field label="Required adults" hint="When kids present">
            <input className="admin-input" type="number" min={0} value={form.requiredAccompanyingAdults} onChange={(e) => setForm({ ...form, requiredAccompanyingAdults: e.target.value })} />
          </Field>
          <Field label="Max extra beds" hint="0 = none">
            <input className="admin-input" type="number" min={0} value={form.maxExtraBeds} onChange={(e) => setForm({ ...form, maxExtraBeds: e.target.value })} />
          </Field>
        </div>
        <button type="button" className="admin-btn w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create room type
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Max occ.</th>
              <th>Max children</th>
              <th>Req. adults</th>
              <th>Max extra beds</th>
              <th>Rooms</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const ed = editing[r.id];
              const isEditing = !!ed;
              return (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.code}</td>
                  <td>
                    {isEditing ? (
                      <input className="admin-input" value={ed.name} onChange={(e) => setEditing((p) => ({ ...p, [r.id]: { ...p[r.id], name: e.target.value } }))} />
                    ) : (
                      r.name
                    )}
                  </td>
                  <CapacityCell value={isEditing ? ed.maxOccupancy ?? r.maxOccupancy : r.maxOccupancy} editing={isEditing} onChange={(v) => setEditing((p) => ({ ...p, [r.id]: { ...p[r.id], maxOccupancy: v } }))} />
                  <CapacityCell value={isEditing ? ed.maxChildren ?? r.maxChildren : r.maxChildren} editing={isEditing} onChange={(v) => setEditing((p) => ({ ...p, [r.id]: { ...p[r.id], maxChildren: v } }))} />
                  <CapacityCell value={isEditing ? ed.requiredAccompanyingAdults ?? r.requiredAccompanyingAdults : r.requiredAccompanyingAdults} editing={isEditing} onChange={(v) => setEditing((p) => ({ ...p, [r.id]: { ...p[r.id], requiredAccompanyingAdults: v } }))} />
                  <CapacityCell value={isEditing ? ed.maxExtraBeds ?? r.maxExtraBeds : r.maxExtraBeds} editing={isEditing} onChange={(v) => setEditing((p) => ({ ...p, [r.id]: { ...p[r.id], maxExtraBeds: v } }))} />
                  <td>{r._count?.rooms ?? 0}</td>
                  <td className="text-right space-x-1">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="admin-btn text-[10px]"
                          disabled={updateMutation.isPending}
                          onClick={() => updateMutation.mutate({
                            id: r.id,
                            body: {
                              name: ed.name?.trim() || undefined,
                              maxOccupancy: ed.maxOccupancy,
                              maxChildren: ed.maxChildren,
                              requiredAccompanyingAdults: ed.requiredAccompanyingAdults,
                              maxExtraBeds: ed.maxExtraBeds,
                            },
                          })}
                        >
                          Save
                        </button>
                        <button type="button" className="admin-btn text-[10px]" onClick={() => setEditing((p) => { const { [r.id]: _drop, ...rest } = p; return rest; })}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="admin-btn text-[10px]" onClick={() => setEditing((p) => ({ ...p, [r.id]: { ...r } }))}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-btn text-[10px] text-destructive"
                          disabled={deleteMutation.isPending}
                          onClick={() => handleDelete(r.id, r.code, r._count?.rooms ?? 0)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function CapacityCell({ value, editing, onChange }: { value?: number; editing: boolean; onChange: (v: number) => void }) {
  if (!editing) return <td className="font-mono text-xs">{value ?? "—"}</td>;
  return (
    <td>
      <input
        className="admin-input w-16"
        type="number"
        min={0}
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </td>
  );
}

function numOr(s: string, fallback: number): number {
  const n = parseInt(s || "", 10);
  return Number.isFinite(n) ? n : fallback;
}
