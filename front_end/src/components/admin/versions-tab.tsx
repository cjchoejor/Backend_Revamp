"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  listVersionSnapshots,
  restoreVersionSnapshot,
  type EntityVersionSnapshot,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";

type Props = {
  /** e.g. "HotelProfile", "Department" — must be in TRACKED_ENTITY_TYPES on the backend. */
  entityType: string;
  /** The row's PK. */
  entityId: string;
  /**
   * Optional — query keys to invalidate after a successful restore so the parent page
   * re-fetches the live row. Pass the same keys the parent uses for its `useQuery`.
   */
  invalidateOnRestore?: readonly unknown[][];
  /**
   * Optional renderer for the row payload. Defaults to a `<pre>` with prettified JSON.
   * Useful for compact summaries on entities with many fields.
   */
  renderPayload?: (rowJson: Record<string, unknown>) => React.ReactNode;
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function defaultRenderPayload(rowJson: Record<string, unknown>) {
  return (
    <pre className="admin-input overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-snug">
      {JSON.stringify(rowJson, null, 2)}
    </pre>
  );
}

/**
 * Drop-in versions panel for any tracked admin entity. Lists snapshots newest-first; each
 * row expands to show the full prior JSON state and offers a "Restore" button (L4 only).
 * Restore captures a fresh snapshot of the current state before reverting, so it's safe.
 */
export function VersionsTab({ entityType, entityId, invalidateOnRestore, renderPayload }: Props) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const enabled = !!session && session.actorLevel === "L4" && !!entityId;
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const snapshotsQuery = useQuery({
    queryKey: ["admin", "versions", entityType, entityId],
    queryFn: () => listVersionSnapshots(session!, { entityType, entityId }),
    enabled,
  });

  const restoreMutation = useMutation({
    mutationFn: (vars: { snapshotId: string; changeNote?: string }) => restoreVersionSnapshot(session!, vars),
    onSuccess: () => {
      toast.success("Restored");
      void queryClient.invalidateQueries({ queryKey: ["admin", "versions", entityType, entityId] });
      for (const key of invalidateOnRestore ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Restore failed"),
  });

  if (!enabled) return null;

  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const renderRow = renderPayload ?? defaultRenderPayload;

  async function handleRestore(s: EntityVersionSnapshot) {
    const note = await promptDialog({
      title: `Restore to version ${s.version}?`,
      message:
        "This will overwrite the current values with the snapshot below. The current state is captured as a new snapshot first, so this is reversible.",
      placeholder: "Reason (optional)",
      multiline: true,
      confirmLabel: "Continue",
    });
    if (note === null) return; // dialog cancelled
    const ok = await confirmDialog({
      title: "Confirm restore",
      message: `Revert ${entityType.replace(/([A-Z])/g, " $1").trim().toLowerCase()} to v${s.version}? A pre-restore snapshot will be captured first.`,
      confirmLabel: "Restore",
      variant: "danger",
    });
    if (!ok) return;
    restoreMutation.mutate({ snapshotId: s.id, changeNote: note.trim() || undefined });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="admin-display text-lg">Version history</h3>
        <p className="admin-muted text-xs">
          {snapshots.length === 0
            ? "No history yet — snapshots are captured on each save."
            : `${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} on record`}
        </p>
      </div>

      {snapshotsQuery.isLoading && <p className="admin-muted text-sm">Loading…</p>}

      {snapshots.length === 0 && !snapshotsQuery.isLoading && (
        <p className="admin-muted text-sm">No prior versions exist. Edit and save the entity to start building history.</p>
      )}

      <div className="space-y-2">
        {snapshots.map((s) => {
          const isOpen = !!expanded[s.id];
          return (
            <div key={s.id} className="admin-panel space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="admin-eyebrow text-xs">Version {s.version}</span>
                  <span className="text-sm">{formatTimestamp(s.changedAt)}</span>
                  <span className="admin-muted text-xs">
                    by <span className="font-mono">{s.changedBy}</span>
                    {s.changeNote && <> · &ldquo;{s.changeNote}&rdquo;</>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="admin-btn admin-btn-ghost admin-btn-sm"
                    onClick={() => setExpanded((m) => ({ ...m, [s.id]: !isOpen }))}
                  >
                    {isOpen ? "Hide" : "View"}
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn-sm"
                    disabled={restoreMutation.isPending}
                    onClick={() => handleRestore(s)}
                  >
                    Restore
                  </button>
                </div>
              </div>
              {isOpen && renderRow(s.rowJson as Record<string, unknown>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
