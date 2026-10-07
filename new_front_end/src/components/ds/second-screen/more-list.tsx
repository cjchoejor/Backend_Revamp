"use client";

/**
 * A list that shows its newest few and folds the rest behind "Show all N" (2026-10-07, operator:
 * "the recorded section keeps increasing — show 4 or 5, and an expand option to see it all").
 */
import { useState, type ReactNode } from "react";

export function MoreList<T>({
  items,
  limit = 5,
  render,
  className,
}: {
  items: T[];
  limit?: number;
  render: (item: T) => ReactNode;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <>
      <ul className={className}>{shown.map(render)}</ul>
      {items.length > limit ? (
        <button type="button" className="btn btn-quiet compact more-toggle" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
    </>
  );
}
