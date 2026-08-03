"use client";

import { Eye } from "lucide-react";
import { STAGES, stageById } from "@/config/stages";
import type { Stage } from "@/types/api";

type Props = {
  viewingStage: Stage;
  currentStage: Stage;
  isTerminal: boolean;
  children: React.ReactNode;
};

/**
 * Renders the stage workspace as read-only when the user is viewing a past (or future) stage
 * relative to the entry's current stage.
 *
 * Visual treatment:
 *  - Banner at top showing what stage is being viewed vs the entry's current stage, with a hint
 *    on where the operator should go to actually act.
 *  - The workspace content is wrapped in a `<fieldset disabled>` which cascades to ALL form
 *    controls (inputs, selects, textareas, buttons) inside — they become unfocusable, unclickable,
 *    and visually de-emphasized. Native HTML behavior; no per-component changes needed.
 *  - Plus a subtle opacity reduction so the read-only state reads at a glance.
 */
export function ReadOnlyShell({ viewingStage, currentStage, isTerminal, children }: Props) {
  const viewing = stageById[viewingStage];
  const current = stageById[currentStage];
  const isPast = viewing && current && viewing.order < current.order;
  const isFuture = viewing && current && viewing.order > current.order;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-amber-300/40 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="flex-1 space-y-0.5">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            Read-only — viewing {viewing?.label ?? viewingStage}
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {isTerminal ? (
              <>This entry is terminal — its workflow has ended. All stages are historical and cannot be edited.</>
            ) : isPast ? (
              <>This stage is in the past. The entry has progressed to <strong>{current?.label}</strong>. To take action, open the current stage.</>
            ) : isFuture ? (
              <>This stage hasn&apos;t been reached yet. The entry is currently at <strong>{current?.label}</strong>.</>
            ) : (
              <>Editing is disabled here.</>
            )}
          </p>
        </div>
      </div>
      {/* fieldset disables all interactive descendants natively. */}
      <fieldset disabled className="min-w-0 space-y-6 opacity-80">
        {children}
      </fieldset>
    </div>
  );
}
