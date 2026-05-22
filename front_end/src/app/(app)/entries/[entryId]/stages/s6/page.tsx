"use client";

import { useParams } from "next/navigation";
import { StagePage } from "@/components/stages/shared/stage-page";
import { GenericStageWorkspace } from "@/components/stages/shared/generic-stage-workspace";

export default function EntryS6Page() {
  const { entryId } = useParams<{ entryId: string }>();
  return (
    <StagePage
      entryId={entryId}
      stage="S6"
      slug="s6"
      render={(entry) => (
        <GenericStageWorkspace
          entry={entry}
          stage="S6"
          progressOptions={{
            guestPhysicallyPresent: true,
            transitionData: { guestPresentConfirmation: true, keyCount: 1, registrationConfirmed: true },
          }}
        />
      )}
    />
  );
}
