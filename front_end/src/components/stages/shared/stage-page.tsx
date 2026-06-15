"use client";

import { EntryWorkspace } from "./entry-workspace";
import { useEntryDetail } from "./entry-detail-context";
import { ReadOnlyShell } from "./read-only-shell";
import type { EntryDetail, Stage } from "@/types/api";

type StagePageProps = {
  entryId: string;
  stage: Stage;
  slug: string;
  render: (entry: EntryDetail) => React.ReactNode;
};

/** Stage route shell — wraps EntryWorkspace (fetch + transition gate) then renders workspace. */
export function StagePage({ entryId, stage, slug, render }: StagePageProps) {
  return (
    <EntryWorkspace entryId={entryId} stageSlug={slug} stage={stage}>
      <StagePageContent render={render} />
    </EntryWorkspace>
  );
}

function StagePageContent({ render }: { render: (entry: EntryDetail) => React.ReactNode }) {
  const { entry, viewingStage, isReadOnly } = useEntryDetail();

  if (!isReadOnly) return <>{render(entry)}</>;

  // Read-only mode: every stage workspace has internal `entry.currentStage === "SX"` conditionals
  // that hide most of its UI when the entry isn't at that stage. To make those conditionals render
  // (so the operator can see what *happened* at this stage), we hand the workspace a synthetic
  // entry with `currentStage = viewingStage`. The real currentStage is preserved on the context
  // (and shown in the banner), and <fieldset disabled> wraps everything so no actions can fire.
  const syntheticEntry: EntryDetail = { ...entry, currentStage: viewingStage };
  const isTerminal = entry.currentStage === ("TERMINAL" as Stage);
  return (
    <ReadOnlyShell viewingStage={viewingStage} currentStage={entry.currentStage} isTerminal={isTerminal}>
      {render(syntheticEntry)}
    </ReadOnlyShell>
  );
}
