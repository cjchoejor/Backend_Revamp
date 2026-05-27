"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S9Workspace } from "@/components/stages/s9/s9-workspace";

export default function EntryS9Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return <StagePage entryId={entryId} stage="S9" slug="s9" render={(entry) => <S9Workspace entry={entry} />} />;
}
