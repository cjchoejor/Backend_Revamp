"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import {
  createRole,
  deleteRole,
  listRoles,
  setRolePermissions,
  upsertRoleSessionConfig,
  updateRole,
  type RoleAdmin,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";

export default function AdminRolesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({ roleCode: "", displayName: "", actorLevel: "L1" as const });
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [permissionsText, setPermissionsText] = useState("");
  const [sessionCfgDraft, setSessionCfgDraft] = useState({ idle: "600", hard: "28800", manual: true });

  const rolesQuery = useQuery({
    queryKey: ["admin", "roles", showInactive],
    queryFn: () => listRoles(session!, showInactive),
    enabled: !!session && session.actorLevel === "L4",
  });

  const items = rolesQuery.data?.items ?? [];
  const selected = useMemo(() => items.find((r) => r.id === selectedRoleId) ?? null, [items, selectedRoleId]);

  const createMutation = useMutation({
    mutationFn: () => createRole(session!, form),
    onSuccess: () => {
      toast.success("Role created");
      setForm({ roleCode: "", displayName: "", actorLevel: "L1" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "roles"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; body: { displayName?: string; actorLevel?: RoleAdmin["actorLevel"]; isActive?: boolean } }) =>
      updateRole(session!, input.id, input.body),
    onSuccess: () => {
      toast.success("Role updated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "roles"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const permissionsMutation = useMutation({
    mutationFn: (input: { id: string; permissionIds: string[] }) => setRolePermissions(session!, input.id, input.permissionIds),
    onSuccess: () => {
      toast.success("Permissions saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "roles"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const sessionCfgMutation = useMutation({
    mutationFn: (input: { id: string; idle: number; hard: number; manualLockAvailable: boolean }) =>
      upsertRoleSessionConfig(session!, input.id, {
        idleLockTimeoutSeconds: input.idle,
        hardLogoutTimeoutSeconds: input.hard,
        manualLockAvailable: input.manualLockAvailable,
      }),
    onSuccess: () => {
      toast.success("Session config saved (snapshots propagated)");
      void queryClient.invalidateQueries({ queryKey: ["admin", "roles"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRole(session!, id),
    onSuccess: () => {
      toast.success("Role deleted");
      setSelectedRoleId("");
      void queryClient.invalidateQueries({ queryKey: ["admin", "roles"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Delete failed"),
  });

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 01 · Identity</p>
        <h1 className="admin-display text-3xl">Roles & sessions</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Manage role registry, attach permissions (string IDs for now), and configure session lock/logout timeouts. Saving a role session config propagates
          the snapshot onto active staff who use the same role code.
        </p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-3">
        <h2 className="admin-display col-span-full text-lg">Create role</h2>
        <input
          className="admin-input"
          placeholder="Role code (e.g. FRONT_DESK)"
          value={form.roleCode}
          onChange={(e) => setForm({ ...form, roleCode: e.target.value })}
        />
        <input
          className="admin-input"
          placeholder="Display name"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        />
        <select className="admin-select" value={form.actorLevel} onChange={(e) => setForm({ ...form, actorLevel: e.target.value as typeof form.actorLevel })}>
          {(["L1", "L2", "L3", "L4"] as const).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="admin-btn col-span-full w-fit" disabled={createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create
        </button>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--admin-ink-soft)]">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="admin-panel p-4">
          <h2 className="admin-display mb-3 text-lg">Role list</h2>
          <div className="space-y-2">
            {items.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setSelectedRoleId(r.id);
                  setPermissionsText(r.permissions.map((p) => p.permissionId).join("\n"));
                  setSessionCfgDraft({
                    idle: String(r.sessionCfg?.idleLockTimeoutSeconds ?? 600),
                    hard: String(r.sessionCfg?.hardLogoutTimeoutSeconds ?? 28800),
                    manual: r.sessionCfg?.manualLockAvailable ?? true,
                  });
                }}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  r.id === selectedRoleId
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs text-[var(--admin-ink-faint)]">{r.roleCode}</div>
                    <div className="text-[var(--admin-ink-soft)]">{r.displayName}</div>
                  </div>
                  <div className="text-xs text-[var(--admin-ink-faint)]">{r.actorLevel}</div>
                </div>
              </button>
            ))}
            {items.length === 0 && <div className="admin-muted text-sm">No roles found</div>}
          </div>
        </div>

        <div className="space-y-6">
          {!selected && (
            <div className="admin-panel p-4">
              <div className="admin-muted text-sm">Select a role to edit permissions and session config.</div>
            </div>
          )}

          {selected && (
            <>
              <div className="admin-panel p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="admin-display text-lg">
                      {selected.displayName} <span className="font-mono text-xs opacity-70">({selected.roleCode})</span>
                    </h2>
                    <p className="admin-muted text-xs">Level {selected.actorLevel} · {selected.isActive ? "active" : "inactive"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="admin-btn text-[10px]" onClick={() => updateMutation.mutate({ id: selected.id, body: { isActive: !selected.isActive } })}>
                      {selected.isActive ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      onClick={() => {
                        const nextName = window.prompt("New display name", selected.displayName);
                        if (nextName && nextName.trim()) updateMutation.mutate({ id: selected.id, body: { displayName: nextName.trim() } });
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="admin-btn text-[10px] text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete role "${selected.roleCode}"? Only works when no staff use this role code.`,
                          )
                        ) {
                          deleteMutation.mutate(selected.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              <div className="admin-panel p-5">
                <h3 className="admin-display text-lg">Permissions</h3>
                <p className="admin-muted mt-1 text-xs">One permission ID per line. (Hard RequiredControlCheck enforcement is coming next.)</p>
                <textarea className="admin-textarea mt-3 min-h-[160px]" value={permissionsText} onChange={(e) => setPermissionsText(e.target.value)} />
                <button
                  type="button"
                  className="admin-btn mt-3 w-fit"
                  onClick={() =>
                    permissionsMutation.mutate({
                      id: selected.id,
                      permissionIds: permissionsText.split("\n").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  disabled={permissionsMutation.isPending}
                >
                  Save permissions
                </button>
              </div>

              <div className="admin-panel p-5">
                <h3 className="admin-display text-lg">Session config</h3>
                <p className="admin-muted mt-1 text-xs">Idle lock must be less than hard logout.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <input className="admin-input" value={sessionCfgDraft.idle} onChange={(e) => setSessionCfgDraft({ ...sessionCfgDraft, idle: e.target.value })} placeholder="Idle lock (sec)" />
                  <input className="admin-input" value={sessionCfgDraft.hard} onChange={(e) => setSessionCfgDraft({ ...sessionCfgDraft, hard: e.target.value })} placeholder="Hard logout (sec)" />
                  <label className="flex items-center gap-2 text-sm text-[var(--admin-ink-soft)]">
                    <input type="checkbox" checked={sessionCfgDraft.manual} onChange={(e) => setSessionCfgDraft({ ...sessionCfgDraft, manual: e.target.checked })} />
                    Manual lock available
                  </label>
                </div>
                <button
                  type="button"
                  className="admin-btn mt-3 w-fit"
                  onClick={() =>
                    sessionCfgMutation.mutate({
                      id: selected.id,
                      idle: Number.parseInt(sessionCfgDraft.idle, 10),
                      hard: Number.parseInt(sessionCfgDraft.hard, 10),
                      manualLockAvailable: sessionCfgDraft.manual,
                    })
                  }
                  disabled={sessionCfgMutation.isPending}
                >
                  Save session config
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

