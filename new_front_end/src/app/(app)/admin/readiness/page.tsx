"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getReadiness, runReadiness } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

function statusClass(status: string) {
  if (status === "OK") return "admin-tag-ok admin-tag";
  if (status === "WARN") return "admin-tag admin-tag-warn";
  return "admin-tag-warn admin-tag";
}

export default function AdminReadinessPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const reportQuery = useQuery({
    queryKey: ["admin", "readiness"],
    queryFn: () => getReadiness(session!),
    enabled: !!session,
  });

  const runMutation = useMutation({
    mutationFn: () => runReadiness(session!),
    onSuccess: (data) => {
      queryClient.setQueryData(["admin", "readiness"], data);
      toast.success(data.ready ? "All checks passed" : "Readiness gaps found");
    },
    onError: () => toast.error("Readiness run failed"),
  });

  const report = reportQuery.data;

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="admin-eyebrow mb-2">ReadinessGateEngine</p>
          <h1 className="admin-display text-3xl">System readiness</h1>
          <p className="admin-muted mt-2 max-w-2xl text-sm">
            Validates core configuration surfaces before stages rely on them. L1+ can view; L4 can re-run on demand.
          </p>
        </div>
        {session?.actorLevel === "L4" && (
          <button type="button" className="admin-btn" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
            {runMutation.isPending ? "Running…" : "Re-run checks"}
          </button>
        )}
      </div>

      {report && (
        <>
          <dl className="admin-stat grid grid-cols-2 md:grid-cols-4">
            <div>
              <dt>Status</dt>
              <dd className="text-xl">{report.ready ? "Ready" : "Gaps"}</dd>
            </div>
            <div>
              <dt>OK</dt>
              <dd>{report.summary.ok}</dd>
            </div>
            <div>
              <dt>Missing</dt>
              <dd>{report.summary.missing}</dd>
            </div>
            <div>
              <dt>Warnings</dt>
              <dd>{report.summary.warnings}</dd>
            </div>
          </dl>

          <div className="admin-panel overflow-x-auto p-4">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((c) => (
                  <tr key={c.id}>
                    <td className="font-mono text-xs">{c.label}</td>
                    <td>
                      <span className={statusClass(c.status)}>{c.status}</span>
                    </td>
                    <td className="text-xs">{c.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="admin-muted text-xs">Last run: {new Date(report.ranAt).toLocaleString()}</p>
        </>
      )}
    </div>
  );
}
