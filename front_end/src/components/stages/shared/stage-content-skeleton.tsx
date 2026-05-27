"use client";

import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder while stage transition completes or entry refetches for the target stage. */
export function StageContentSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
