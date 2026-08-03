"use client";

import { Check, ChevronUp, Lock, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepStatus = "locked" | "active" | "done";

type StepCardProps = {
  step: number;
  status: StepStatus;
  title: string;
  /** One-line description, shown beneath the title in all states. */
  description?: string;
  /** Compact summary rendered when status === "done". Shown in place of the full content. */
  summary?: React.ReactNode;
  /** Full step content — rendered when status === "active". */
  children?: React.ReactNode;
  /** Called when the user clicks "Edit" on a completed step. */
  onEdit?: () => void;
  /**
   * Called when the user clicks "Close" while in edit mode — exits the editor without
   * saving any in-flight changes. Pass to collapse a step they only opened to inspect.
   */
  onClose?: () => void;
  /** True when the step is currently shown because of an Edit click (vs. naturally active). */
  isEditing?: boolean;
  /** When status === "locked", this is shown explaining what unlocks the step. */
  lockedHint?: string;
  /**
   * When true, children stay mounted in the DOM even when the step is "done" (collapsed).
   * Their state is preserved across collapse/expand cycles. Used for the inquiry intake
   * form so the user's typed fields aren't lost when they click "Edit" on a completed step.
   */
  keepMounted?: boolean;
};

export function StepCard({
  step,
  status,
  title,
  description,
  summary,
  children,
  onEdit,
  onClose,
  isEditing,
  lockedHint,
  keepMounted,
}: StepCardProps) {
  const isActive = status === "active";
  const isDone = status === "done";
  const isLocked = status === "locked";

  return (
    <section
      className={cn(
        "rounded-2xl border bg-card transition-all",
        isActive && "border-primary/50 shadow-md ring-1 ring-primary/10",
        isDone && "border-border",
        isLocked && "border-dashed border-border bg-muted/30",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-3 px-5 py-4",
          (isDone || isLocked) && "border-b border-border/40",
        )}
      >
        <StatusBubble step={step} status={status} />
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "font-semibold leading-tight",
              isLocked && "text-muted-foreground",
              isActive && "text-foreground",
            )}
          >
            {title}
          </h3>
          {description && (
            <p className={cn("text-xs", isLocked ? "text-muted-foreground/70" : "text-muted-foreground")}>
              {description}
            </p>
          )}
        </div>
        {isDone && onEdit && !isEditing && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`Edit step ${step}`}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
        {isEditing && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`Close step ${step}`}
          >
            <ChevronUp className="h-3 w-3" />
            Close
          </button>
        )}
      </header>

      {/* Active: render visible. Done + keepMounted: render hidden so component state persists. */}
      {children && (isActive || (isDone && keepMounted)) && (
        <div className={cn("px-5 py-5", !isActive && "hidden")}>{children}</div>
      )}

      {isDone && summary && (
        <div className="px-5 py-3 text-sm text-muted-foreground">{summary}</div>
      )}

      {isLocked && lockedHint && (
        <div className="px-5 py-3 text-xs text-muted-foreground italic">{lockedHint}</div>
      )}
    </section>
  );
}

function StatusBubble({ step, status }: { step: number; status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30">
        <Check className="h-4 w-4" />
      </span>
    );
  }
  if (status === "locked") {
    return (
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
        <Lock className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground text-sm font-semibold ring-1 ring-primary/30">
      {step}
    </span>
  );
}
