"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { progressStage, getEntry } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { ApiErrorAlert } from "./api-error-alert";
import { stagePath, stageById } from "@/config/stages";
import { useStageTransitionOptional } from "./stage-transition-context";
import { useIsInBookingFlow } from "@/components/booking-flow/booking-flow-context";
import type { EntryDetail, Stage } from "@/types/api";

type ProgressStageButtonProps = {
  entryId: string;
  version: number;
  targetStage: Stage;
  label?: string;
  guestPhysicallyPresent?: boolean;
  transitionData?: Record<string, unknown>;
  variant?: "default" | "gradient" | "outline";
  disabled?: boolean;
  /** Navigate to the target stage workspace after a successful transition (default true). */
  navigateOnSuccess?: boolean;
};

export function ProgressStageButton({
  entryId,
  version,
  targetStage,
  label,
  guestPhysicallyPresent,
  transitionData,
  variant = "gradient",
  disabled = false,
  navigateOnSuccess = true,
}: ProgressStageButtonProps) {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const stageTransition = useStageTransitionOptional();
  const inBookingFlow = useIsInBookingFlow();
  const shouldNavigate = navigateOnSuccess && !inBookingFlow;
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (shouldNavigate) router.prefetch(stagePath(entryId, targetStage));
  }, [router, entryId, targetStage, shouldNavigate]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");

      stageTransition?.startTransition({
        targetStage,
        label: `Advancing to ${stageById[targetStage]?.shortLabel ?? targetStage}…`,
      });

      const cached = queryClient.getQueryData<EntryDetail>(["entry", entryId]);
      const versionToSend = cached?.version ?? version;

      return progressStage(session, entryId, {
        targetStage,
        version: versionToSend,
        guestPhysicallyPresent,
        transitionData,
      });
    },
    onSuccess: async (updated) => {
      setError(null);
      let entryForCache: EntryDetail = updated;
      if (session) {
        try {
          entryForCache = await getEntry(session, entryId);
        } catch {
          /* progress response may be partial; keep updated if refetch fails */
        }
      }
      queryClient.setQueryData(["entry", entryId], entryForCache);
      queryClient.invalidateQueries({ queryKey: ["entries"] });

      const stageAfter = entryForCache?.currentStage ?? targetStage;
      const dest = shouldNavigate && stageAfter ? stagePath(entryId, stageAfter) : null;

      if (session && dest) {
        await queryClient.prefetchQuery({
          queryKey: ["entry", entryId],
          queryFn: () => getEntry(session, entryId),
        });
      }

      toast.success(`Moved to ${targetStage}`);

      if (dest) {
        router.push(dest);
      } else if (inBookingFlow) {
        // Embedded: signal the orchestrator to end any pending transition skeleton.
        stageTransition?.endTransition();
      }
    },
    onError: async (e) => {
      stageTransition?.endTransition();
      setError(e);
      if (e instanceof ApiError && e.message.includes("version")) {
        await queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
        try {
          if (session) await getEntry(session, entryId);
        } catch {
          /* ignore refresh failure */
        }
      }
      toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Progress failed");
    },
  });

  return (
    <div className="space-y-3">
      <Button
        variant={variant}
        onClick={() => mutation.mutate()}
        disabled={disabled || mutation.isPending}
      >
        {mutation.isPending ? "Progressing…" : (label ?? `Advance to ${targetStage}`)}
      </Button>
      <ApiErrorAlert error={error} />
    </div>
  );
}
