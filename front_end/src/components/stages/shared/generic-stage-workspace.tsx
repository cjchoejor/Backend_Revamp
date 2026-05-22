"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StagePanel } from "./stage-panel";
import { ProgressStageButton } from "./progress-stage-button";
import { stageById } from "@/config/stages";
import type { EntryDetail, Stage } from "@/types/api";

const NEXT_STAGE: Partial<Record<Stage, Stage>> = {
  S1: "S2",
  S2: "S3",
  S3: "S4",
  S5: "S6",
  S6: "S7",
  S7: "S8",
  S8: "S9",
};

type GenericStageWorkspaceProps = {
  entry: EntryDetail;
  stage: Stage;
  extra?: React.ReactNode;
  progressOptions?: {
    guestPhysicallyPresent?: boolean;
    transitionData?: Record<string, unknown>;
  };
};

export function GenericStageWorkspace({
  entry,
  stage,
  extra,
  progressOptions,
}: GenericStageWorkspaceProps) {
  const meta = stageById[stage];
  const next = NEXT_STAGE[stage];
  const canProgress = entry.currentStage === stage && next;

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Entry state</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">Status:</span> {entry.status}
            </p>
            <p>
              <span className="text-muted-foreground">Version:</span> {entry.version}
            </p>
            <p>
              <span className="text-muted-foreground">Check-in:</span>{" "}
              {entry.checkInDate?.slice(0, 10) ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Check-out:</span>{" "}
              {entry.checkOutDate?.slice(0, 10) ?? "—"}
            </p>
            {entry.folio != null && (
              <p className="sm:col-span-2">
                <span className="text-muted-foreground">Folio:</span> attached
              </p>
            )}
            {entry.committedHold != null && (
              <p className="sm:col-span-2">
                <span className="text-muted-foreground">Committed hold:</span> active
              </p>
            )}
            {entry.roomAssignments && Array.isArray(entry.roomAssignments) && (
              <p className="sm:col-span-2">
                <span className="text-muted-foreground">Room assignments:</span>{" "}
                {(entry.roomAssignments as unknown[]).length}
              </p>
            )}
          </CardContent>
        </Card>

        {extra}

        {canProgress && next && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stage progression</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">
                Advance when all policy gates for {meta.shortLabel} are satisfied.
              </p>
              <ProgressStageButton
                entryId={entry.id}
                version={entry.version}
                targetStage={next}
                guestPhysicallyPresent={progressOptions?.guestPhysicallyPresent}
                transitionData={progressOptions?.transitionData}
              />
            </CardContent>
          </Card>
        )}

        {entry.currentStage !== stage && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            This entry is currently at {entry.currentStage}. Actions may be read-only.
          </p>
        )}
      </div>
    </StagePanel>
  );
}
