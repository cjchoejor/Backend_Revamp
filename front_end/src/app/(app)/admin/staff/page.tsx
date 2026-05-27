"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createStaff,
  deactivateStaff,
  listStaff,
  resetStaffPin,
  type StaffUserAdmin,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminStaffPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    actorLevel: "L1" as const,
    role: "FRONT_DESK",
    pin: "",
    idleThresholdSeconds: "600",
    hardLogoutThresholdSeconds: "28800",
  });

  const staffQuery = useQuery({
    queryKey: ["admin", "staff", showInactive],
    queryFn: () => listStaff(session!, showInactive),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createStaff(session!, {
        fullName: form.fullName,
        email: form.email || null,
        actorLevel: form.actorLevel,
        role: form.role,
        pin: form.pin,
        idleThresholdSeconds: Number.parseInt(form.idleThresholdSeconds, 10),
        hardLogoutThresholdSeconds: Number.parseInt(form.hardLogoutThresholdSeconds, 10),
      }),
    onSuccess: () => {
      toast.success("Staff created");
      setForm({ ...form, fullName: "", email: "", pin: "" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateStaff(session!, id),
    onSuccess: () => {
      toast.success("Staff deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const resetPinMutation = useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: string }) => resetStaffPin(session!, id, pin),
    onSuccess: () => toast.success("PIN reset"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "PIN reset failed"),
  });

  const items = staffQuery.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 01 · Identity</p>
        <h1 className="admin-display text-3xl">Staff registry</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Create and deactivate staff. PINs are hashed — never returned after save. Session timeouts snapshot on
          create.
        </p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <h2 className="admin-display col-span-full text-lg">Create staff</h2>
        <input
          className="admin-input"
          placeholder="Full name"
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
        />
        <input
          className="admin-input"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <select
          className="admin-select"
          value={form.actorLevel}
          onChange={(e) => setForm({ ...form, actorLevel: e.target.value as typeof form.actorLevel })}
        >
          {(["L1", "L2", "L3", "L4"] as const).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input
          className="admin-input"
          placeholder="Role code (e.g. FRONT_DESK)"
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}
        />
        <input
          className="admin-input"
          placeholder="PIN (min 4)"
          type="password"
          value={form.pin}
          onChange={(e) => setForm({ ...form, pin: e.target.value })}
        />
        <input
          className="admin-input"
          placeholder="Idle lock (seconds)"
          value={form.idleThresholdSeconds}
          onChange={(e) => setForm({ ...form, idleThresholdSeconds: e.target.value })}
        />
        <input
          className="admin-input"
          placeholder="Hard logout (seconds)"
          value={form.hardLogoutThresholdSeconds}
          onChange={(e) => setForm({ ...form, hardLogoutThresholdSeconds: e.target.value })}
        />
        <button
          type="button"
          className="admin-btn col-span-full w-fit"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          Create staff
        </button>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--admin-ink-soft)]">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Level</th>
              <th>Role</th>
              <th>Session</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((row: StaffUserAdmin) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.fullName}</strong>
                  {row.email && <div className="text-xs opacity-70">{row.email}</div>}
                </td>
                <td>{row.actorLevel}</td>
                <td className="font-mono text-xs">{row.role}</td>
                <td className="text-xs">
                  idle {row.idleThresholdSeconds}s / hard {row.hardLogoutThresholdSeconds}s
                </td>
                <td>{row.isActive ? <span className="admin-tag-ok admin-tag">active</span> : <span className="admin-tag-warn admin-tag">inactive</span>}</td>
                <td className="space-x-2 text-right">
                  {row.isActive && (
                    <>
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        onClick={() => {
                          const pin = window.prompt("New PIN (min 4 chars)");
                          if (pin) resetPinMutation.mutate({ id: row.id, pin });
                        }}
                      >
                        Reset PIN
                      </button>
                      <button
                        type="button"
                        className="admin-btn text-[10px]"
                        onClick={() => {
                          if (window.confirm(`Deactivate ${row.fullName}?`)) {
                            deactivateMutation.mutate(row.id);
                          }
                        }}
                      >
                        Deactivate
                      </button>
                    </>
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
