"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-session";
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";
import { ApiError } from "@/lib/api/client";
import {
  BACKFLOWS_BY_STAGE,
  COMPLAINT_APPLICABLE_STAGES,
  backflows,
  type BackflowDescriptor,
} from "@/lib/api/backflows";

/**
 * Backflow menu — dropdown of applicable regression paths for the entry's current stage.
 *
 * What's applicable:
 *   - From the source stage, whatever `BACKFLOWS_BY_STAGE[currentStage]` declares.
 *   - "Complaint resolution" from anywhere except S2 (already there) or S9 (closed).
 * Each button is disabled when the actor lacks the minimum authority — the server also
 * enforces (defence-in-depth) but disabling in the UI stops accidental error toasts.
 *
 * The friend's real production frontend can consume the same `/api/entries/:id/backflow/*`
 * endpoints — this component is the testing-frontend surface only.
 */

type Level = "L1" | "L2" | "L3" | "L4";
const rank: Record<Level, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export function BackflowMenu({ entryId, currentStage }: { entryId: string; currentStage: string | null | undefined }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [open, setOpen] = useState(false);

  const actorLevel = (session?.actorLevel ?? "L1") as Level;

  const stageBackflows = useMemo(() => {
    if (!currentStage) return [];
    return BACKFLOWS_BY_STAGE[currentStage] ?? [];
  }, [currentStage]);

  const complaintApplicable = currentStage != null && COMPLAINT_APPLICABLE_STAGES.has(currentStage);

  const runMutation = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      toast.success("Backflow completed");
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      setOpen(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : (e as Error)?.message ?? "Backflow failed"),
  });

  async function handlePick(descriptor: BackflowDescriptor) {
    if (!session) return;
    if (rank[actorLevel] < rank[descriptor.minLevel]) {
      toast.error(`Requires ${descriptor.minLevel} authority — you are ${actorLevel}.`);
      return;
    }
    const reason = await prompt({
      title: descriptor.label,
      message: `Enter a reason (mandatory — captured in the audit trace).`,
      placeholder: "e.g. Guest called to change check-out date",
      inputType: "text",
      confirmLabel: "Continue",
      minLength: 1,
    });
    if (!reason) return;

    let newCheckOutDate: string | undefined;
    if (descriptor.needsNewCheckOutDate) {
      const dateStr = await prompt({
        title: "New check-out date",
        message: "Enter the new check-out date (YYYY-MM-DD). Must be later than the current one.",
        placeholder: "2026-08-14",
        inputType: "text",
        confirmLabel: "Continue",
        minLength: 10,
      });
      if (!dateStr) return;
      if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        toast.error("Date must be YYYY-MM-DD.");
        return;
      }
      newCheckOutDate = dateStr;
    }

    const ok = await confirm({
      title: `Confirm: ${descriptor.label}`,
      message: descriptor.destructive
        ? `This will move the entry back to ${descriptor.toStage}. Historical hold + invoices on the current segment will be released / superseded. This is a re-entry — an audit trail is preserved but the operational state changes immediately.`
        : `Move this entry from ${currentStage} → ${descriptor.toStage}. Reason recorded on the audit trail.`,
      confirmLabel: `Move to ${descriptor.toStage}`,
      variant: descriptor.destructive ? "danger" : undefined,
    });
    if (!ok) return;

    switch (descriptor.key) {
      case "s2ToS1":
        runMutation.mutate(() => backflows.s2ToS1(session, entryId, reason));
        break;
      case "s4ToS1":
        runMutation.mutate(() => backflows.s4ToS1(session, entryId, reason));
        break;
      case "s4ToS2":
        runMutation.mutate(() => backflows.s4ToS2(session, entryId, reason));
        break;
      case "s4ToS3":
        runMutation.mutate(() => backflows.s4ToS3(session, entryId, reason));
        break;
      case "s5ToS1":
        runMutation.mutate(() => backflows.s5ToS1(session, entryId, reason));
        break;
      case "s7ToS2":
        runMutation.mutate(() => backflows.s7ToS2(session, entryId, reason));
        break;
      case "s7ToS3":
        runMutation.mutate(() => backflows.s7ToS3(session, entryId, reason));
        break;
      case "s7ToS4":
        if (!newCheckOutDate) return;
        runMutation.mutate(() => backflows.s7ToS4(session, entryId, reason, newCheckOutDate!));
        break;
      case "complaintToS2":
        runMutation.mutate(() => backflows.complaintToS2(session, entryId, reason));
        break;
    }
  }

  async function handleComplaint() {
    if (!session) return;
    if (rank[actorLevel] < rank.L2) {
      toast.error("Requires L2 authority.");
      return;
    }
    const reason = await prompt({
      title: "Complaint resolution — reason",
      message: "Describe the guest complaint or reason for goodwill adjustment (recorded on the audit trace).",
      placeholder: "e.g. Room service delay — offering goodwill discount",
      inputType: "text",
      confirmLabel: "Continue",
      minLength: 1,
    });
    if (!reason) return;
    const ok = await confirm({
      title: "Confirm complaint resolution",
      message: `Move this entry from ${currentStage} → S2 for commercial adjustment. Folio continues; the new S2 segment carries the goodwill negotiation.`,
      confirmLabel: "Move to S2",
    });
    if (!ok) return;
    runMutation.mutate(() => backflows.complaintToS2(session, entryId, reason));
  }

  if (!currentStage || (stageBackflows.length === 0 && !complaintApplicable)) return null;

  return (
    <div className="relative inline-block">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        Backflow ▾
      </Button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 w-80 rounded-md border bg-popover p-2 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <p className="mb-1 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Backflows from {currentStage}
          </p>
          {stageBackflows.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No stage-specific backflows from {currentStage}.</p>
          )}
          {stageBackflows.map((b) => {
            const permitted = rank[actorLevel] >= rank[b.minLevel];
            return (
              <button
                key={b.key}
                type="button"
                disabled={!permitted || runMutation.isPending}
                className={`block w-full rounded px-2 py-2 text-left text-sm ${
                  permitted ? "hover:bg-accent" : "cursor-not-allowed opacity-40"
                } ${b.destructive ? "text-destructive" : ""}`}
                onClick={() => handlePick(b)}
                title={permitted ? undefined : `Requires ${b.minLevel} — you are ${actorLevel}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{b.label}</span>
                  <span className="text-[10px] opacity-70">→ {b.toStage} · {b.minLevel}+</span>
                </div>
              </button>
            );
          })}
          {complaintApplicable && (
            <>
              <div className="my-1 border-t" />
              <button
                type="button"
                disabled={rank[actorLevel] < rank.L2 || runMutation.isPending}
                className={`block w-full rounded px-2 py-2 text-left text-sm ${
                  rank[actorLevel] >= rank.L2 ? "hover:bg-accent" : "cursor-not-allowed opacity-40"
                }`}
                onClick={handleComplaint}
                title={rank[actorLevel] >= rank.L2 ? undefined : `Requires L2 — you are ${actorLevel}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>Complaint / goodwill resolution</span>
                  <span className="text-[10px] opacity-70">→ S2 · L2+</span>
                </div>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
