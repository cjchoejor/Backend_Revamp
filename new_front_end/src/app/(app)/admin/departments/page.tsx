"use client";

import { AdmField } from "@/components/admin/field-title";
import { Help } from "@/components/ds/help";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { createDepartment, listDepartments, updateDepartment, type DepartmentAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminDepartmentsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({ departmentCode: "", departmentName: "" });

  const departmentsQuery = useQuery({
    queryKey: ["admin", "departments", showInactive],
    queryFn: () => listDepartments(session!, showInactive),
    enabled: !!session && session.actorLevel === "L4",
  });

  const createMutation = useMutation({
    mutationFn: () => createDepartment(session!, { departmentCode: form.departmentCode, departmentName: form.departmentName }),
    onSuccess: () => {
      toast.success("Department created");
      setForm({ departmentCode: "", departmentName: "" });
      void queryClient.invalidateQueries({ queryKey: ["admin", "departments"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (row: DepartmentAdmin) =>
      updateDepartment(session!, row.id, { expectedVersion: row.version, isActive: !row.isActive }),
    onSuccess: () => {
      toast.success("Department updated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "departments"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const items = departmentsQuery.data?.items ?? [];

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">The hotel and its people</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Departments
          <Help label="Departments">The hotel's departments.</Help>
        </h1>
      </div>

      <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
        <h2 className="admin-display col-span-full text-lg">Create department</h2>
        <AdmField label="Department code" hint="e.g. FRONT_OFFICE">
          <input
            className="admin-input"
            value={form.departmentCode}
            onChange={(e) => setForm({ ...form, departmentCode: e.target.value })}
          />
        </AdmField>
        <AdmField label="Department name">
          <input
            className="admin-input"
            value={form.departmentName}
            onChange={(e) => setForm({ ...form, departmentName: e.target.value })}
          />
        </AdmField>
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

      <div className="admin-panel overflow-x-auto p-4">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Version</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td className="font-mono text-xs">{row.departmentCode}</td>
                <td>
                  <strong>{row.departmentName}</strong>
                </td>
                <td className="text-xs">{row.version}</td>
                <td>{row.isActive ? <span className="admin-tag-ok admin-tag">active</span> : <span className="admin-tag-warn admin-tag">inactive</span>}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="admin-btn text-[10px]"
                    onClick={() => toggleActiveMutation.mutate(row)}
                    disabled={toggleActiveMutation.isPending}
                  >
                    {row.isActive ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="admin-muted py-6 text-center text-sm">
                  No departments found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

