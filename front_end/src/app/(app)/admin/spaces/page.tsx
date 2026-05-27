"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createSpace, deleteSpace, listSpaces, updateSpace } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminSpacesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ code: "", name: "", capacity: "0" });

  const query = useQuery({
    queryKey: ["admin", "spaces"],
    queryFn: () => listSpaces(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createSpace(session!, {
        code: form.code,
        name: form.name,
        capacity: Number.parseInt(form.capacity, 10) || 0,
      }),
    onSuccess: () => {
      toast.success("Space created");
      setForm({ code: "", name: "", capacity: "0" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "spaces"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const toggleMutation = useMutation({
    mutationFn: (row: { id: string; isAvailable: boolean }) => updateSpace(session!, row.id, { isAvailable: !row.isAvailable }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "spaces"] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSpace(session!, id),
    onSuccess: () => {
      toast.success("Space deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin", "spaces"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 02 · Inventory</p>
        <h1 className="admin-display text-3xl">Spaces</h1>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-3">
        <input className="admin-input" placeholder="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input className="admin-input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="admin-input" placeholder="Capacity" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create space
        </button>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Capacity</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">{s.code}</td>
                <td>{s.name}</td>
                <td>{s.spaceType}</td>
                <td>{s.capacity}</td>
                <td>{s.isAvailable ? <span className="admin-tag-ok admin-tag">available</span> : <span className="admin-tag-warn admin-tag">unavailable</span>}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    <button type="button" className="admin-btn text-[10px]" onClick={() => toggleMutation.mutate(s)}>
                      {s.isAvailable ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="admin-btn text-[10px] text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete space "${s.code}"?`)) deleteMutation.mutate(s.id);
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
      </div>
    </div>
  );
}
