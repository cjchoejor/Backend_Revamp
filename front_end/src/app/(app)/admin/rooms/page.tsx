"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createAdminRoom, deactivateAdminRoom, deleteAdminRoom, getDeficientCategories, listAdminRooms, listRoomTypes, markRoomDeficient, reactivateAdminRoom, resolveRoomDeficient } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

type DeficientForm = { roomId: string; roomNumber: string; category: string; description: string; deadline: string };

export default function AdminRoomsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ roomNumber: "", roomTypeId: "", floorNumber: "", capacity: "2" });
  const [defForm, setDefForm] = useState<DeficientForm | null>(null);

  const roomsQuery = useQuery({
    queryKey: ["admin", "rooms"],
    queryFn: () => listAdminRooms(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const roomTypesQuery = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createAdminRoom(session!, {
        roomNumber: form.roomNumber,
        roomTypeId: form.roomTypeId,
        floorNumber: form.floorNumber ? Number.parseInt(form.floorNumber, 10) : null,
        capacity: Number.parseInt(form.capacity, 10) || 2,
      }),
    onSuccess: () => {
      toast.success("Room created");
      setForm({ roomNumber: "", roomTypeId: form.roomTypeId, floorNumber: "", capacity: "2" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room deactivated (blocked)");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  const resolveDeficientMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => resolveRoomDeficient(session!, id, note),
    onSuccess: () => {
      toast.success("Deficient condition resolved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Resolve failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateAdminRoom(session!, id),
    onSuccess: () => {
      toast.success("Room reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  const markDeficientMutation = useMutation({
    mutationFn: () => {
      if (!defForm) throw new Error("No form");
      return markRoomDeficient(session!, defForm.roomId, {
        category: defForm.category,
        description: defForm.description,
        resolutionDeadline: defForm.deadline ? new Date(defForm.deadline).toISOString() : null,
      });
    },
    onSuccess: () => {
      toast.success("Room marked deficient");
      setDefForm(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "rooms"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Mark deficient failed"),
  });

  const categoriesQuery = useQuery({
    queryKey: ["admin", "deficient-categories"],
    queryFn: () => getDeficientCategories(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const rooms = roomsQuery.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 02 · Inventory</p>
        <h1 className="admin-display text-3xl">Room inventory</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Register rooms and review claim state. Operational claim transitions are not edited here.
        </p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <h2 className="admin-display col-span-full text-lg">Add room</h2>
        <input className="admin-input" placeholder="Room number" value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} />
        <select className="admin-select" value={form.roomTypeId} onChange={(e) => setForm({ ...form, roomTypeId: e.target.value })}>
          <option value="">Select room type</option>
          {(roomTypesQuery.data?.items ?? []).map((rt) => (
            <option key={rt.id} value={rt.id}>
              {rt.code} — {rt.name}
            </option>
          ))}
        </select>
        <input className="admin-input" placeholder="Floor" value={form.floorNumber} onChange={(e) => setForm({ ...form, floorNumber: e.target.value })} />
        <input className="admin-input" placeholder="Capacity" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create room
        </button>
      </div>

      <div className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Deficient condition categories</h2>
        {categoriesQuery.data?.isSystemDefault && <span className="admin-tag mb-3 inline-block">system default</span>}
        <p className="admin-muted text-xs">
          These categories are the allowed reasons when marking a room deficient. Edit the list under{" "}
          <span className="font-mono text-[var(--admin-brass)]">Configuration → deficientCondition.categories</span>.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {(Array.isArray(categoriesQuery.data?.configValue) ? (categoriesQuery.data!.configValue as Array<{ code: string; label: string; isActive?: boolean }>) : []).map((c) => (
            <li key={c.code} className="flex items-center justify-between rounded border border-[var(--admin-rule)] px-3 py-2 text-xs">
              <span>
                <span className="font-mono">{c.code}</span> · {c.label}
              </span>
              {c.isActive === false && <span className="admin-tag admin-tag-warn">inactive</span>}
            </li>
          ))}
        </ul>
      </div>

      {defForm && (
        <div className="admin-panel space-y-3 p-5">
          <h2 className="admin-display text-lg">Mark room {defForm.roomNumber} deficient</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="admin-muted text-xs">
              Category
              <select
                className="admin-select mt-1 w-full"
                value={defForm.category}
                onChange={(e) => setDefForm({ ...defForm, category: e.target.value })}
              >
                <option value="">Select category…</option>
                {(Array.isArray(categoriesQuery.data?.configValue) ? (categoriesQuery.data!.configValue as Array<{ code: string; label: string; isActive?: boolean }>) : [])
                  .filter((c) => c.isActive !== false)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label} ({c.code})
                    </option>
                  ))}
              </select>
            </label>
            <label className="admin-muted text-xs">
              Resolution deadline (optional)
              <input
                className="admin-input mt-1 w-full"
                type="datetime-local"
                value={defForm.deadline}
                onChange={(e) => setDefForm({ ...defForm, deadline: e.target.value })}
              />
            </label>
            <label className="admin-muted text-xs md:col-span-2">
              Description
              <textarea
                className="admin-input mt-1 w-full"
                rows={2}
                placeholder="What's wrong with the room?"
                value={defForm.description}
                onChange={(e) => setDefForm({ ...defForm, description: e.target.value })}
              />
            </label>
          </div>
          <p className="admin-muted text-xs">
            Defaults the deadline to <span className="font-mono">deficientResolution.deadlineHours</span> from now (48h if not configured).
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="admin-btn w-fit"
              disabled={markDeficientMutation.isPending || !defForm.category || defForm.description.trim().length < 3}
              onClick={() => markDeficientMutation.mutate()}
            >
              Confirm mark deficient
            </button>
            <button type="button" className="admin-btn w-fit" onClick={() => setDefForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Type</th>
              <th>Floor</th>
              <th>Claim</th>
              <th>Physical</th>
              <th>Deficient</th>
              <th>Blocked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.roomNumber}</strong>
                </td>
                <td>
                  {r.roomType.name} <span className="text-xs opacity-60">({r.roomType.code})</span>
                </td>
                <td>{r.floorNumber ?? "—"}</td>
                <td>{r.currentClaimState}</td>
                <td>{r.physicalState}</td>
                <td>{r.isDeficient ? "Yes" : "—"}</td>
                <td>{r.isBlocked ? "Yes" : "—"}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    {r.isDeficient && (
                      <button
                        type="button"
                        className="admin-btn admin-btn-success text-[10px]"
                        disabled={resolveDeficientMutation.isPending}
                        onClick={() => {
                          const note = window.prompt(`Resolve deficient condition on room ${r.roomNumber}. Resolution notes (optional):`, "");
                          if (note === null) return;
                          resolveDeficientMutation.mutate({ id: r.id, note: note.trim() || undefined });
                        }}
                      >
                        Mark resolved
                      </button>
                    )}
                    {!r.isDeficient && !r.isBlocked && (
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        onClick={() =>
                          setDefForm({
                            roomId: r.id,
                            roomNumber: r.roomNumber,
                            category: "",
                            description: "",
                            deadline: "",
                          })
                        }
                      >
                        Mark deficient
                      </button>
                    )}
                    {r.isBlocked ? (
                      <button
                        type="button"
                        className="admin-btn admin-btn-success text-[10px]"
                        disabled={reactivateMutation.isPending}
                        onClick={() => reactivateMutation.mutate(r.id)}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        disabled={deactivateMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Deactivate room ${r.roomNumber}? It will be marked blocked.`)) {
                            deactivateMutation.mutate(r.id);
                          }
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                    <button
                      type="button"
                      className="admin-btn text-[10px] text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (r.currentClaimState !== "FREE") {
                          toast.error("Only FREE rooms with no history can be deleted — use Deactivate instead");
                          return;
                        }
                        if (window.confirm(`Permanently delete room ${r.roomNumber}?`)) {
                          deleteMutation.mutate(r.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="admin-muted mt-3 text-xs">{rooms.length} room(s)</p>
      </div>
    </div>
  );
}
