"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S5Workspace } from "@/components/stages/s5/s5-workspace";

export default function EntryS5Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S5" slug="s5" render={(entry) => <S5Workspace entry={entry} />} />
  );
}
