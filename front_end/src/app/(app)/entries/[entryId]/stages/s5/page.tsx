"use client";

import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StagePage } from "@/components/stages/shared/stage-page";
import { GenericStageWorkspace } from "@/components/stages/shared/generic-stage-workspace";

export default function EntryS5Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage
      entryId={entryId}
      stage="S5"
      slug="s5"
      render={(entry) => (
        <GenericStageWorkspace
          entry={entry}
          stage="S5"
          extra={
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pre-arrival tasks</CardTitle>
              </CardHeader>
              <CardContent>
                {entry.preArrivalTasks && Array.isArray(entry.preArrivalTasks) ? (
                  <ul className="space-y-2 text-sm">
                    {(entry.preArrivalTasks as { id: string; taskType?: string; status?: string }[]).map(
                      (t) => (
                        <li key={t.id} className="flex justify-between rounded-lg border px-3 py-2">
                          <span>{t.taskType ?? t.id}</span>
                          <span className="text-muted-foreground">{t.status}</span>
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No pre-arrival tasks loaded</p>
                )}
              </CardContent>
            </Card>
          }
        />
      )}
    />
  );
}
