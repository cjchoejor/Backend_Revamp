"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S8Workspace } from "@/components/stages/s8/s8-workspace";

export default function EntryS8Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S8" slug="s8" render={(entry) => <S8Workspace entry={entry} />} />
  );
}
