"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getEntry } from "@/lib/api/entries";
import { stagePath } from "@/config/stages";
import { useSession } from "@/hooks/use-session";
import { EntryHeader } from "@/components/stages/shared/entry-header";
import { StageStepper } from "@/components/stages/shared/stage-stepper";
import { Skeleton } from "@/components/ui/skeleton";

export default function EntryOverviewPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const router = useRouter();
  const { session } = useSession();

  const { data: entry, isLoading } = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session && !!entryId,
  });

  useEffect(() => {
    if (entry) {
      router.replace(stagePath(entry.id, entry.currentStage));
    }
  }, [entry, router]);

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  if (!entry) return <p className="text-destructive">Entry not found</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <EntryHeader entry={entry} />
      <StageStepper entryId={entryId} currentStage={entry.currentStage} />
      <p className="text-sm text-muted-foreground">Redirecting to stage workspace…</p>
    </div>
  );
}
