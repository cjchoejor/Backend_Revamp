"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { STAGES, stageById, stagePath } from "@/config/stages";
import { useStageTransition } from "./stage-transition-context";
import type { Stage } from "@/types/api";

type StageStepperProps = {
  entryId: string;
  currentStage: Stage;
  activeSlug?: string;
};

export function StageStepper({ entryId, currentStage, activeSlug }: StageStepperProps) {
  const { startTransition } = useStageTransition();
  const currentOrder = STAGES.find((s) => s.id === currentStage)?.order ?? 0;

  return (
    <nav className="flex flex-wrap gap-1 rounded-xl border bg-card p-2">
      {STAGES.map((stage) => {
        const isCurrent = stage.id === currentStage;
        const isPast = stage.order < currentOrder;
        const isActive = activeSlug === stage.slug;
        return (
          <Link
            key={stage.id}
            href={stagePath(entryId, stage.id)}
            onClick={() => {
              if (stage.slug === activeSlug) return;
              startTransition({
                targetStage: stage.id,
                label: `Opening ${stageById[stage.id]?.label ?? stage.id}…`,
              });
            }}
            className={cn(
              "rounded-lg px-3 py-2 text-xs font-medium transition-colors",
              isActive && "bg-primary text-primary-foreground",
              !isActive && isCurrent && "bg-secondary text-secondary-foreground",
              !isActive && !isCurrent && isPast && "text-muted-foreground hover:bg-muted",
              !isActive && !isCurrent && !isPast && "text-muted-foreground/50 hover:bg-muted/50",
            )}
          >
            {stage.shortLabel}
          </Link>
        );
      })}
    </nav>
  );
}
