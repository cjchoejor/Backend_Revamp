"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stageById, stagePath } from "@/config/stages";
import type { EntryDetail } from "@/types/api";
import { StageBadge } from "./stage-badge";
import { formatListId } from "@/lib/readable-id";
import { useStageTransition } from "./stage-transition-context";
import { GroupBadge } from "@/components/entries/group-badge";
import { GroupBillingModeToggle } from "@/components/entries/group-billing-mode-toggle";
import { BackflowMenu } from "@/components/entries/backflow-menu";

export function EntryHeader({ entry }: { entry: EntryDetail }) {
  const { startTransition } = useStageTransition();

  return (
    <div className="space-y-3 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{formatListId(entry.id)}</p>
          <h2 className="mt-1 font-display text-xl font-semibold">
            {entry.guestProfile?.displayName ?? "Guest entry"}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StageBadge stage={entry.currentStage} />
            <Badge variant={entry.status === "PARKED" ? "secondary" : "muted"}>{entry.status}</Badge>
            <Badge variant="outline">v{entry.version}</Badge>
            <GroupBadge groupBillingMode={entry.groupBillingMode} />
            <GroupBillingModeToggle entryId={entry.id} currentMode={entry.groupBillingMode} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Backflow menu — regression paths applicable at this stage (see BACKFLOWS_BY_STAGE) */}
          <BackflowMenu entryId={entry.id} currentStage={entry.currentStage} />
          {entry.currentStage && (
            <Button variant="gradient" asChild>
              <Link
                href={stagePath(entry.id, entry.currentStage)}
                onClick={() =>
                  startTransition({
                    targetStage: entry.currentStage,
                    label: `Opening ${stageById[entry.currentStage!]?.label ?? entry.currentStage}…`,
                  })
                }
              >
                Current stage workspace
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
