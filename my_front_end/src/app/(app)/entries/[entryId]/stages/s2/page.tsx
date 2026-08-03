"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S2Workspace } from "@/components/stages/s2/s2-workspace";

export default function EntryS2Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S2" slug="s2" render={(entry) => <S2Workspace entry={entry} />} />
  );
}
