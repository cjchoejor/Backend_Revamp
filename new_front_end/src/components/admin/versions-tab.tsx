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
  renderPayload?: (rowJson: Record<string, unknown>, previous?: Record<string, unknown> | null) => React.ReactNode;
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Bookkeeping columns nobody audits — hidden so the fields that matter are not buried. */
const NOISE_FIELDS = new Set(["id", "createdAt", "updatedAt", "createdBy"]);

/** "contactNumbers" -> "Contact numbers"; "gstNumber" -> "Gst number". */
function humanizeField(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Render one stored value as something an operator can read, never as raw JSON. */
function humanizeValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") return <span className="admin-muted">—</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="admin-muted">none</span>;
    // Arrays of contact objects ({name, phone, email}) read far better as lines than as JSON.
    if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      return (
        <div className="space-y-0.5">
          {v.map((x, i) => (
            <div key={i}>
              {Object.entries(x as Record<string, unknown>)
                .filter(([, val]) => val !== null && val !== undefined && val !== "")
                .map(([k, val]) => `${humanizeField(k)}: ${String(val)}`)
                .join(" · ") || <span className="admin-muted">empty</span>}
            </div>
          ))}
        </div>
      );
    }
    return v.map((x) => String(x)).join(", ");
  }
  if (typeof v === "object") {
    return (
      <div className="space-y-0.5">
        {Object.entries(v as Record<string, unknown>).map(([k, val]) => (
          <div key={k}>
            <span className="admin-muted">{humanizeField(k)}:</span> {String(val)}
          </div>
        ))}
      </div>
    );
  }
  const str = String(v);
  // ISO timestamps stored as strings should read as dates, not as machine text.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) {
    try { return new Date(str).toLocaleString(); } catch { return str; }
  }
  return str;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * A readable field table instead of a JSON blob.
 *
 * `previous` is the version immediately BEFORE this one, so each row can say whether this
 * version is where the field actually changed — the question anyone opening a version history
 * is really asking. Without it every version looks identical and the reader has to diff by eye.
 */
function defaultRenderPayload(rowJson: Record<string, unknown>, previous?: Record<string, unknown> | null) {
  const entries = Object.entries(rowJson).filter(([k]) => !NOISE_FIELDS.has(k));
  if (entries.length === 0) {
    return <p className="admin-muted text-xs">Nothing recorded on this version.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="admin-table">
        <thead>
          <tr><th style={{ width: "30%" }}>Field</th><th>Value at this version</th></tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => {
            const changed = previous ? !sameValue(v, previous[k]) : false;
            return (
              <tr key={k}>
                <td className="align-top">
                  {humanizeField(k)}
                  {changed && <span className="admin-tag ml-2 text-[10px]">changed</span>}
                </td>
                <td className="align-top text-sm">{humanizeValue(v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
        {snapshots.map((s, idx) => {
          const isOpen = !!expanded[s.id];
          // Newest-first, so the chronologically previous version is the NEXT row down.
          const previous = (snapshots[idx + 1]?.rowJson ?? null) as Record<string, unknown> | null;
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
              {isOpen && renderRow(s.rowJson as Record<string, unknown>, previous)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
