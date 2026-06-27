"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, X } from "lucide-react";
import { getEntryTrace } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { TraceEventRow } from "@/components/trace/trace-event-row";

const STORAGE_KEY = "entry-trace-panel-open";

export function EntryTracePanel({ entryId: explicitEntryId }: { entryId?: string } = {}) {
  const routeParams = useParams<{ entryId?: string }>();
  const entryId = explicitEntryId ?? routeParams?.entryId;
  const { session } = useSession();
  const [open, setOpen] = useState(false);

  // Restore the user's preference (default: minimized).
  useEffect(() => {
    setOpen(typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1");
  }, []);
  const setOpenPersisted = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const query = useQuery({
    queryKey: ["entry-trace", entryId],
    queryFn: () => getEntryTrace(session!, entryId!),
    enabled: !!session && !!entryId && open,
    refetchInterval: open ? 15000 : false,
  });

  if (!session || !entryId) return null;

  const items = query.data?.items ?? [];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpenPersisted(true)}
        className="fixed bottom-6 right-4 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-lg transition hover:bg-accent"
        aria-label="Show activity timeline"
      >
        <Activity className="h-4 w-4" />
        Activity
      </button>
    );
  }

  return (
    <aside className="fixed right-0 top-16 bottom-0 z-40 flex w-[360px] max-w-[90vw] flex-col border-l border-border bg-card shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Activity timeline</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => query.refetch()}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setOpenPersisted(false)}
            aria-label="Hide activity timeline"
            title="Hide"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        What has happened to this booking, newest first. Updates automatically.
      </p>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {query.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {!query.isLoading && items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No recorded activity for this booking yet.</p>
        )}
        <div className="divide-y divide-border">
          {items.map((e) => (
            <TraceEventRow key={e.id} event={e} compact />
          ))}
        </div>
      </div>
    </aside>
  );
}
