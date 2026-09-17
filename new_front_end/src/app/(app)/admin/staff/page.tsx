"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createStaff,
  deactivateStaff,
  listRoles,
  listStaff,
  purgeStaff,
  resetStaffPin,
  updateStaff,
  type RoleAdmin,
  type StaffUserAdmin,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";

type ActorLevel = "L1" | "L2" | "L3" | "L4";
const LEVELS: ActorLevel[] = ["L1", "L2", "L3", "L4"];

const PIN_REGEX = /^\d{4}$/;
const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/i;

export default function AdminStaffPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    username: "",
    email: "",
    actorLevel: "L1" as ActorLevel,
    roleId: "",
    pin: "",
    idleThresholdSeconds: "600",
    hardLogoutThresholdSeconds: "28800",
  });

  const staffQuery = useQuery({
    queryKey: ["admin", "staff", showInactive],
    queryFn: () => listStaff(session!, showInactive),
    enabled: !!session && session.actorLevel === "L4",
  });

  const rolesQuery = useQuery({
    queryKey: ["admin", "roles"],
    queryFn: () => listRoles(session!, false),
    enabled: !!session && session.actorLevel === "L4",
  });

  const roles = rolesQuery.data?.items ?? [];
  // Filter role dropdown to roles matching the currently-picked actor level so a mismatch
  // doesn't sneak past — the backend also validates.
  const rolesForLevel = useMemo(
    () => roles.filter((r: RoleAdmin) => r.actorLevel === form.actorLevel && r.isActive),
    [roles, form.actorLevel],
  );

  const createMutation = useMutation({
    mutationFn: () => {
      if (!USERNAME_REGEX.test(form.username)) {
        throw new Error("Username: 3–32 chars, letters/digits/./_/- only.");
      }
      if (!PIN_REGEX.test(form.pin)) {
        throw new Error("PIN must be exactly 4 digits.");
      }
      const roleRow = roles.find((r) => r.id === form.roleId);
      if (!roleRow) {
        throw new Error("Pick a role from the dropdown.");
      }
      return createStaff(session!, {
        fullName: form.fullName,
        username: form.username.trim().toLowerCase(),
        email: form.email || null,
        actorLevel: form.actorLevel,
        role: roleRow.roleCode,
        roleId: form.roleId,
        pin: form.pin,
        idleThresholdSeconds: Number.parseInt(form.idleThresholdSeconds, 10),
        hardLogoutThresholdSeconds: Number.parseInt(form.hardLogoutThresholdSeconds, 10),
      });
    },
    onSuccess: () => {
      toast.success("Staff created");
      setForm((prev) => ({ ...prev, fullName: "", username: "", email: "", pin: "" }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Create failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof updateStaff>[2] }) =>
      updateStaff(session!, id, body),
    onSuccess: () => {
      toast.success("Staff updated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateStaff(session!, id),
    onSuccess: () => {
      toast.success("Staff deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => purgeStaff(session!, id),
    onSuccess: () => {
      toast.success("Staff permanently deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Purge failed"),
  });

  const resetPinMutation = useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: string }) => resetStaffPin(session!, id, pin),
    onSuccess: () => toast.success("PIN reset"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "PIN reset failed"),
  });

  const items = staffQuery.data?.items ?? [];

  // Editing a row inline — we track a single editing row at a time. The row expands under itself
  // with editable name / username / role / level.
  const [editing, setEditing] = useState<{ id: string; fullName: string; username: string; roleId: string; actorLevel: ActorLevel } | null>(null);
  const editingRolesForLevel = useMemo(
    () => (editing ? roles.filter((r) => r.actorLevel === editing.actorLevel && r.isActive) : []),
    [roles, editing],
  );

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 01 · Identity</p>
        <h1 className="admin-display text-3xl">Staff registry</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">
          Full lifecycle: create staff, assign role, reset 4-digit PIN, edit name / username, deactivate (soft), or
          delete permanently. Deactivating a user terminates all active sessions immediately.
        </p>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <h2 className="admin-display col-span-full text-lg">Create staff</h2>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Full name
          <input
            className="admin-input mt-1"
            placeholder="Sonam Wangchuk"
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Username (for login)
          <input
            className="admin-input mt-1"
            placeholder="sonam.wangchuk"
            autoCapitalize="none"
            spellCheck={false}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Email (optional)
          <input
            className="admin-input mt-1"
            placeholder="sonam@example.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Actor level
          <select
            className="admin-select mt-1"
            value={form.actorLevel}
            onChange={(e) =>
              setForm({ ...form, actorLevel: e.target.value as ActorLevel, roleId: "" })
            }
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Role
          <select
            className="admin-select mt-1"
            value={form.roleId}
            onChange={(e) => setForm({ ...form, roleId: e.target.value })}
          >
            <option value="">— pick a role —</option>
            {rolesForLevel.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName} · {r.roleCode}
              </option>
            ))}
          </select>
          {form.actorLevel && rolesForLevel.length === 0 && (
            <p className="mt-1 text-[10px] text-amber-500">
              No roles configured for level {form.actorLevel}. Create one on /admin/roles first.
            </p>
          )}
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          4-digit PIN
          <input
            className="admin-input mt-1"
            placeholder="e.g. 5678"
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={form.pin}
            onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
          />
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Idle lock (seconds)
          <input
            className="admin-input mt-1"
            placeholder="600"
            value={form.idleThresholdSeconds}
            onChange={(e) => setForm({ ...form, idleThresholdSeconds: e.target.value })}
          />
        </label>

        <label className="col-span-full text-xs opacity-70 md:col-span-1">
          Hard logout (seconds)
          <input
            className="admin-input mt-1"
            placeholder="28800"
            value={form.hardLogoutThresholdSeconds}
            onChange={(e) => setForm({ ...form, hardLogoutThresholdSeconds: e.target.value })}
          />
        </label>

        <button
          type="button"
          className="admin-btn col-span-full w-fit"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? "Creating…" : "Create staff"}
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
              <th>Username</th>
              <th>Level</th>
              <th>Role</th>
              <th>Session</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((row: StaffUserAdmin) => (
              <StaffRow
                key={row.id}
                row={row}
                editing={editing?.id === row.id ? editing : null}
                editingRolesForLevel={editingRolesForLevel}
                allRoles={roles}
                onStartEdit={() =>
                  setEditing({
                    id: row.id,
                    fullName: row.fullName,
                    username: row.username,
                    roleId: row.roleId ?? row.roleRef?.id ?? "",
                    actorLevel: (row.actorLevel as ActorLevel) ?? "L1",
                  })
                }
                onCancelEdit={() => setEditing(null)}
                onEditingChange={(next) => setEditing((prev) => (prev ? { ...prev, ...next } : prev))}
                onSaveEdit={() => {
                  if (!editing) return;
                  if (!USERNAME_REGEX.test(editing.username)) {
                    toast.error("Username: 3–32 chars, letters/digits/./_/- only.");
                    return;
                  }
                  updateMutation.mutate({
                    id: editing.id,
                    body: {
                      fullName: editing.fullName,
                      username: editing.username.trim().toLowerCase(),
                      actorLevel: editing.actorLevel,
                      roleId: editing.roleId || null,
                      role: roles.find((r) => r.id === editing.roleId)?.roleCode,
                    },
                  });
                  setEditing(null);
                }}
                onResetPin={async () => {
                  const pin = await prompt({
                    title: `Reset PIN for ${row.fullName}`,
                    message: "Enter the new 4-digit PIN. The user will use this to sign in next time.",
                    inputType: "password",
                    placeholder: "New PIN (4 digits)",
                    confirmLabel: "Reset PIN",
                    minLength: 4,
                  });
                  if (!pin) return;
                  if (!PIN_REGEX.test(pin)) {
                    toast.error("PIN must be exactly 4 digits.");
                    return;
                  }
                  resetPinMutation.mutate({ id: row.id, pin });
                }}
                onDeactivate={async () => {
                  const ok = await confirm({
                    title: "Deactivate staff member",
                    message: `Deactivate ${row.fullName}? Any active sessions will be terminated immediately and they won't be able to sign in until reactivated.`,
                    confirmLabel: "Deactivate",
                    variant: "danger",
                  });
                  if (ok) deactivateMutation.mutate(row.id);
                }}
                onPurge={async () => {
                  const ok = await confirm({
                    title: "Permanently delete staff member",
                    message: `PERMANENTLY delete ${row.fullName} (${row.username})? This cannot be undone. Their audit history remains but the account is gone.`,
                    confirmLabel: "Delete forever",
                    variant: "danger",
                  });
                  if (ok) purgeMutation.mutate(row.id);
                }}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-sm opacity-60">
                  No staff members match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffRow(props: {
  row: StaffUserAdmin;
  editing: { id: string; fullName: string; username: string; roleId: string; actorLevel: ActorLevel } | null;
  editingRolesForLevel: RoleAdmin[];
  allRoles: RoleAdmin[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditingChange: (next: Partial<{ fullName: string; username: string; roleId: string; actorLevel: ActorLevel }>) => void;
  onSaveEdit: () => void;
  onResetPin: () => void;
  onDeactivate: () => void;
  onPurge: () => void;
}) {
  const { row, editing } = props;
  if (editing) {
    return (
      <tr>
        <td colSpan={7} className="!p-0">
          <div className="grid gap-3 border-l-4 border-[var(--admin-accent)] bg-[var(--admin-panel-alt)] p-4 md:grid-cols-4">
            <label className="text-xs opacity-70">
              Full name
              <input
                className="admin-input mt-1"
                value={editing.fullName}
                onChange={(e) => props.onEditingChange({ fullName: e.target.value })}
              />
            </label>
            <label className="text-xs opacity-70">
              Username
              <input
                className="admin-input mt-1"
                value={editing.username}
                onChange={(e) => props.onEditingChange({ username: e.target.value })}
              />
            </label>
            <label className="text-xs opacity-70">
              Level
              <select
                className="admin-select mt-1"
                value={editing.actorLevel}
                onChange={(e) =>
                  props.onEditingChange({ actorLevel: e.target.value as ActorLevel, roleId: "" })
                }
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs opacity-70">
              Role
              <select
                className="admin-select mt-1"
                value={editing.roleId}
                onChange={(e) => props.onEditingChange({ roleId: e.target.value })}
              >
                <option value="">— none —</option>
                {props.editingRolesForLevel.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName} · {r.roleCode}
                  </option>
                ))}
              </select>
            </label>
            <div className="col-span-full flex justify-end gap-2">
              <button type="button" className="admin-btn" onClick={props.onCancelEdit}>
                Cancel
              </button>
              <button type="button" className="admin-btn" onClick={props.onSaveEdit}>
                Save changes
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        <strong>{row.fullName}</strong>
        {row.email && <div className="text-xs opacity-70">{row.email}</div>}
      </td>
      <td className="font-mono text-xs">{row.username}</td>
      <td>{row.actorLevel}</td>
      <td className="font-mono text-xs">{row.roleRef?.displayName ?? row.role}</td>
      <td className="text-xs">
        idle {row.idleThresholdSeconds}s / hard {row.hardLogoutThresholdSeconds}s
      </td>
      <td>
        {row.isActive ? (
          <span className="admin-tag-ok admin-tag">active</span>
        ) : (
          <span className="admin-tag-warn admin-tag">inactive</span>
        )}
      </td>
      <td className="space-x-2 whitespace-nowrap text-right">
        {row.isActive && (
          <>
            <button type="button" className="admin-btn text-[10px]" onClick={props.onStartEdit}>
              Edit
            </button>
            <button type="button" className="admin-btn text-[10px]" onClick={props.onResetPin}>
              Reset PIN
            </button>
            <button type="button" className="admin-btn text-[10px]" onClick={props.onDeactivate}>
              Deactivate
            </button>
          </>
        )}
        <button type="button" className="admin-btn text-[10px] text-red-500" onClick={props.onPurge}>
          Delete
        </button>
      </td>
    </tr>
  );
}
