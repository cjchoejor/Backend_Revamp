"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { GenericStageWorkspace } from "@/components/stages/shared/generic-stage-workspace";

export default function EntryS7Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S7" slug="s7" render={(entry) => <GenericStageWorkspace entry={entry} stage="S7" />} />
  );
}
