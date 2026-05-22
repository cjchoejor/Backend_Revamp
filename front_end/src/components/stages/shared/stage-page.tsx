"use client";

import { useQuery } from "@tanstack/react-query";
import { getEntry } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { EntryWorkspace } from "./entry-workspace";
import type { EntryDetail, Stage } from "@/types/api";

type StagePageProps = {
  entryId: string;
  stage: Stage;
  slug: string;
  render: (entry: EntryDetail) => React.ReactNode;
};

export function StagePage({ entryId, stage, slug, render }: StagePageProps) {
  const { session } = useSession();

  return (
    <EntryWorkspace entryId={entryId} stageSlug={slug} stage={stage}>
      <StagePageInner entryId={entryId} sessionReady={!!session} render={render} />
    </EntryWorkspace>
  );
}

function StagePageInner({
  entryId,
  sessionReady,
  render,
}: {
  entryId: string;
  sessionReady: boolean;
  render: (entry: EntryDetail) => React.ReactNode;
}) {
  const { session } = useSession();
  const { data: entry } = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: sessionReady && !!session,
  });

  if (!entry) return null;
  return <>{render(entry)}</>;
}
