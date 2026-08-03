"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S7Workspace } from "@/components/stages/s7/s7-workspace";

export default function EntryS7Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S7" slug="s7" render={(entry) => <S7Workspace entry={entry} />} />
  );
}
