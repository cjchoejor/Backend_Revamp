"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S6Workspace } from "@/components/stages/s6/s6-workspace";

export default function EntryS6Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S6" slug="s6" render={(entry) => <S6Workspace entry={entry} />} />
  );
}
