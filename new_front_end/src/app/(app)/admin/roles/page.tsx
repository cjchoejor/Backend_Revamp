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
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";
import { cn } from "@/lib/utils";
import { useSelectionParam } from "@/hooks/use-selection-param";
import { DurationInput } from "@/components/admin/duration-input";
import { Help } from "@/components/ds/help";

const LEVEL_WORD: Record<string, string> = { L1: "Front desk", L2: "FOM", L3: "GM", L4: "Administrator" };

export default function AdminRolesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({ roleCode: "", displayName: "", actorLevel: "L1" as const });
  const [selectedRoleIdRaw, setSelectedRoleId] = useSelectionParam("role");
  const selectedRoleId = selectedRoleIdRaw ?? "";
  const [permissionList, setPermissionList] = useState<string[]>([]);
  const [permInput, setPermInput] = useState("");
  const [sessionCfgDraft, setSessionCfgDraft] = useState({ idle: 600, hard: 28800, manual: true });

  const rolesQuery = useQuery({
    queryKey: ["admin", "roles", showInactive],
    queryFn: () => listRoles(session!, showInactive),
    enabled: !!session && session.actorLevel === "L4",
  });

  const items = rolesQuery.data?.items ?? [];
  const selected = useMemo(() => items.find((r) => r.id === selectedRoleId) ?? null, [items, selectedRoleId]);

  // Distinct permission IDs seen across all roles — used as quick-add suggestions.
  const knownPermissions = useMemo(() => {
    const set = new Set<string>();
    for (const r of items) for (const p of r.permissions) set.add(p.permissionId);
    return [...set].sort();
  }, [items]);

  const addPermission = (id: string) => {
    const v = id.trim();
    if (!v) return;
    setPermissionList((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setPermInput("");
  };
  const removePermission = (id: string) => setPermissionList((prev) => prev.filter((p) => p !== id));

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
      toast.success("Session times saved");
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
        <p className="admin-eyebrow mb-2">The hotel and its people</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Roles
          <Help label="Roles">Each role has its level, what it may do, and how long a sign-in lasts. Saving the times passes them on to the staff who hold that role.</Help>
        </h1>
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
              {LEVEL_WORD[l]}
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
                  setPermissionList(r.permissions.map((p) => p.permissionId));
                  setPermInput("");
                  setSessionCfgDraft({
                    idle: r.sessionCfg?.idleLockTimeoutSeconds ?? 600,
                    hard: r.sessionCfg?.hardLogoutTimeoutSeconds ?? 28800,
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
                  <div className="text-xs text-[var(--admin-ink-faint)]">{LEVEL_WORD[r.actorLevel] ?? r.actorLevel}</div>
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
                    <p className="admin-muted text-xs">{LEVEL_WORD[selected.actorLevel] ?? selected.actorLevel} · {selected.isActive ? "active" : "inactive"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="admin-btn text-[10px]" onClick={() => updateMutation.mutate({ id: selected.id, body: { isActive: !selected.isActive } })}>
                      {selected.isActive ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      className="admin-btn text-[10px]"
                      onClick={async () => {
                        const nextName = await prompt({
                          title: "Rename role",
                          message: `Set a new display name for role "${selected.roleCode}". The role code (used by code) won't change.`,
                          initialValue: selected.displayName,
                          confirmLabel: "Save",
                        });
                        if (nextName && nextName.trim()) updateMutation.mutate({ id: selected.id, body: { displayName: nextName.trim() } });
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="admin-btn text-[10px] text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete role",
                          message: `Delete role "${selected.roleCode}"? Only works when no staff are currently assigned to this role code.`,
                          confirmLabel: "Delete",
                          variant: "danger",
                        });
                        if (ok) deleteMutation.mutate(selected.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              <div className="admin-panel p-5">
                <h3 className="admin-display text-lg">Permissions</h3>
                <p className="admin-muted mt-1 text-xs">Add or remove permission keys, then save. The backend runs a RequiredControlCheck to reject changes that would leave a required action uncovered.</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {permissionList.length === 0 && <span className="admin-muted text-xs">No permissions assigned.</span>}
                  {permissionList.map((p) => (
                    <span key={p} className="admin-tag inline-flex items-center gap-1 font-mono text-[10px]">
                      {p}
                      <button type="button" className="text-destructive" aria-label={`Remove ${p}`} onClick={() => removePermission(p)}>×</button>
                    </span>
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    className="admin-input w-72"
                    placeholder="Add permission key (e.g. quotation.create)"
                    value={permInput}
                    onChange={(e) => setPermInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addPermission(permInput);
                      }
                    }}
                  />
                  <button type="button" className="admin-btn" onClick={() => addPermission(permInput)}>Add</button>
                </div>

                {knownPermissions.filter((p) => !permissionList.includes(p)).length > 0 && (
                  <div className="mt-3">
                    <p className="admin-muted text-[10px] uppercase tracking-wide">Quick add (used by other roles)</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {knownPermissions.filter((p) => !permissionList.includes(p)).map((p) => (
                        <button key={p} type="button" className="admin-btn font-mono text-[10px]" onClick={() => addPermission(p)}>+ {p}</button>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  className="admin-btn mt-4 w-fit"
                  onClick={() => permissionsMutation.mutate({ id: selected.id, permissionIds: permissionList })}
                  disabled={permissionsMutation.isPending}
                >
                  Save permissions
                </button>
              </div>

              <div className="admin-panel p-5">
                <h3 className="admin-display text-lg">Locking and signing out</h3>
                <div className="sf-grid mt-3">
                  <div className="sf-field">
                    <span className="sf-label">
                      Locks after
                      <Help label="Locks after">How long the terminal can sit untouched before it locks and asks for the PIN again.</Help>
                    </span>
                    <DurationInput base="seconds" units={["hours", "minutes"]} aria-label="Locks after" value={sessionCfgDraft.idle} onChange={(n) => setSessionCfgDraft({ ...sessionCfgDraft, idle: n })} />
                  </div>
                  <div className="sf-field">
                    <span className="sf-label">
                      Signs out after
                      <Help label="Signs out after">How long a sign-in lasts before the person has to sign in again, however busy they are.</Help>
                    </span>
                    <DurationInput base="seconds" units={["hours", "minutes"]} aria-label="Signs out after" value={sessionCfgDraft.hard} onChange={(n) => setSessionCfgDraft({ ...sessionCfgDraft, hard: n })} />
                    {sessionCfgDraft.hard <= sessionCfgDraft.idle ? <span className="sf-error" role="alert">It must be longer than the lock.</span> : null}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-[var(--admin-ink-soft)]">
                    <input type="checkbox" checked={sessionCfgDraft.manual} onChange={(e) => setSessionCfgDraft({ ...sessionCfgDraft, manual: e.target.checked })} />
                    They can lock it themselves
                  </label>
                </div>
                <button
                  type="button"
                  className="admin-btn mt-3 w-fit"
                  onClick={() =>
                    sessionCfgMutation.mutate({
                      id: selected.id,
                      idle: sessionCfgDraft.idle,
                      hard: sessionCfgDraft.hard,
                      manualLockAvailable: sessionCfgDraft.manual,
                    })
                  }
                  disabled={sessionCfgMutation.isPending || sessionCfgDraft.hard <= sessionCfgDraft.idle}
                >
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

