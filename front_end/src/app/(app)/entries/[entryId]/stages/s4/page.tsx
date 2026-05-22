"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S4Workspace } from "@/components/stages/s4/s4-workspace";

export default function EntryS4Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S4" slug="s4" render={(entry) => <S4Workspace entry={entry} />} />
  );
}
