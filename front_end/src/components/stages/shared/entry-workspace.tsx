"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { getEntry } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { Skeleton } from "@/components/ui/skeleton";
import { EntryHeader } from "./entry-header";
import { StageStepper } from "./stage-stepper";
import { StageTransitionProvider, useStageTransition } from "./stage-transition-context";
import { StageTransitionOverlay } from "./stage-transition-overlay";
import type { Stage } from "@/types/api";

type EntryWorkspaceProps = {
  entryId: string;
  stageSlug: string;
  stage: Stage;
  children: React.ReactNode;
};

export function EntryWorkspace({ entryId, stageSlug, stage, children }: EntryWorkspaceProps) {
  return (
    <StageTransitionProvider>
      <EntryWorkspaceInner entryId={entryId} stageSlug={stageSlug} stage={stage}>
        {children}
      </EntryWorkspaceInner>
      <StageTransitionOverlay />
    </StageTransitionProvider>
  );
}

function EntryWorkspaceInner({ entryId, stageSlug, stage, children }: EntryWorkspaceProps) {
  const { session } = useSession();
  const { active: transitionActive, endTransition } = useStageTransition();
  const { data: entry, isLoading, isFetching, error } = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session,
  });

  useEffect(() => {
    if (transitionActive && !isLoading && !isFetching && entry) {
      endTransition();
    }
  }, [transitionActive, isLoading, isFetching, entry, endTransition]);

  if (isLoading && !transitionActive) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !entry) {
    if (transitionActive) endTransition();
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-destructive">Failed to load entry</p>
        <Link href="/entries" className="mt-2 inline-block text-sm text-primary hover:underline">
          Back to entries
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <EntryHeader entry={entry} />
      <StageStepper entryId={entryId} currentStage={entry.currentStage} activeSlug={stageSlug} />
      {children}
    </div>
  );
}
