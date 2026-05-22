"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S1Workspace } from "@/components/stages/s1/s1-workspace";

export default function EntryS1Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S1" slug="s1" render={(entry) => <S1Workspace entry={entry} />} />
  );
}
