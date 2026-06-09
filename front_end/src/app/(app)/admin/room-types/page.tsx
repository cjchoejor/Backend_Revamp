"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createRoomType, deleteRoomType, listRoomTypes } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";

export default function AdminRoomTypesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState({ code: "", name: "" });

  const query = useQuery({
    queryKey: ["admin", "room-types"],
    queryFn: () => listRoomTypes(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () => createRoomType(session!, form),
    onSuccess: () => {
      toast.success("Room type created");
      setForm({ code: "", name: "" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "room-types"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
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
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <input className="admin-input" placeholder="Code (e.g. DLX)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create room type
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Rooms</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.code}</td>
                <td>{r.name}</td>
                <td>{r._count?.rooms ?? 0}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="admin-btn text-[10px] text-destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() => handleDelete(r.id, r.code, r._count?.rooms ?? 0)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
