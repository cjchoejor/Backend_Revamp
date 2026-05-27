"use client";

import { EntryWorkspace } from "./entry-workspace";
import { useEntryDetail } from "./entry-detail-context";
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
  const { entry } = useEntryDetail();
  return <>{render(entry)}</>;
}
