"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { S3Workspace } from "@/components/stages/s3/s3-workspace";

export default function EntryS3Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage entryId={entryId} stage="S3" slug="s3" render={(entry) => <S3Workspace entry={entry} />} />
  );
}
