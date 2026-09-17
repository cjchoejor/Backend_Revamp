"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { setGroupBillingMode } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

type Props = {
  entryId: string;
  currentMode: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null | undefined;
};

/**
 * L3+ manual override for the auto-classification set by Policy 64. Visible only to L3 / L4
 * actors. Opens a small inline panel with a mode dropdown and a required reason field so the
 * audit trail (`ENTRY.GROUP_BILLING_MODE_MANUALLY_SET` trace event) records why. Setting the
 * "re-enable Policy 64" checkbox clears the manual-override lock — subsequent intake edits
 * will re-classify from the guest count again.
 */
export function GroupBillingModeToggle({ entryId, currentMode }: Props) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"GROUP_MASTER" | "INDIVIDUAL_FOLIO" | "NULL">(currentMode ?? "NULL");
  const [reason, setReason] = useState("");
  const [clearOverride, setClearOverride] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      setGroupBillingMode(session!, entryId, {
        mode: mode === "NULL" ? null : mode,
        reason: reason.trim(),
        clearManualOverride: clearOverride,
      }),
    onSuccess: () => {
      toast.success("Group billing mode updated");
      setOpen(false);
      setReason("");
      setClearOverride(false);
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  if (!session || (session.actorLevel !== "L3" && session.actorLevel !== "L4")) return null;

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Users className="h-3.5 w-3.5" />
        Override group mode
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Manually set group billing mode</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Currently: <span className="font-mono">{currentMode ?? "NULL (individual)"}</span>. This action is L3+
        only and gets audited.
      </p>
      <div className="space-y-2">
        <div>
          <label className="text-xs text-muted-foreground">Set to</label>
          <select
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="GROUP_MASTER">GROUP_MASTER — group booking</option>
            <option value="INDIVIDUAL_FOLIO">INDIVIDUAL_FOLIO — individual</option>
            <option value="NULL">NULL — clear classification</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Reason (audit)</label>
          <input
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this override?"
          />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={clearOverride} onChange={(e) => setClearOverride(e.target.checked)} />
          Re-enable Policy 64 auto-classify on subsequent intake edits
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="gradient"
          size="sm"
          disabled={mutation.isPending || reason.trim().length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Saving…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
