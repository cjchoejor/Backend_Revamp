"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { queryAuditEvents, type AuditEventFilters } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { TraceEventRow } from "@/components/trace/trace-event-row";

const PAGE_SIZE = 50;
const EMPTY: AuditEventFilters = { actorId: "", entityType: "", entityId: "", eventType: "", from: "", to: "" };

export default function AdminAuditTrailPage() {
  const { session } = useSession();
  const [draft, setDraft] = useState<AuditEventFilters>(EMPTY);
  const [applied, setApplied] = useState<AuditEventFilters>(EMPTY);
  const [page, setPage] = useState(0);

  const enabled = !!session && session.actorLevel === "L4";
  const query = useQuery({
    queryKey: ["admin", "audit-events", applied, page],
    queryFn: () => queryAuditEvents(session!, { ...applied, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled,
    placeholderData: keepPreviousData,
  });

  if (!session || session.actorLevel !== "L4") return null;

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const apply = () => {
    setApplied(draft);
    setPage(0);
  };
  const clear = () => {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(0);
  };

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Generic · Audit visibility</p>
        <h1 className="admin-display text-3xl">Audit trail</h1>
        <p className="admin-muted mt-1">
          A plain-language, read-only history of everything that happens in the system — who did what, to which record,
          and when. Filter to narrow it down.
        </p>
      </div>

      <div className="admin-panel grid gap-3 p-5 md:grid-cols-3">
        <label className="admin-muted text-xs">What happened (event)
          <input className="admin-input mt-1" placeholder="e.g. rate plan, cancelled, login" value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })} />
        </label>
        <label className="admin-muted text-xs">Who (name or id, partial)
          <input className="admin-input mt-1" placeholder="e.g. admin-1 or Admin 1" value={draft.actorId} onChange={(e) => setDraft({ ...draft, actorId: e.target.value })} />
        </label>
        <label className="admin-muted text-xs">Record type (partial)
          <input className="admin-input mt-1" placeholder="e.g. entry, config, reservation" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })} />
        </label>
        <label className="admin-muted text-xs">Record id
          <input className="admin-input mt-1" placeholder="exact record id" value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} />
        </label>
        <label className="admin-muted text-xs">From
          <input className="admin-input mt-1" type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="admin-muted text-xs">To
          <input className="admin-input mt-1" type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <div className="col-span-full flex gap-2">
          <button type="button" className="admin-btn w-fit" onClick={apply}>Apply filters</button>
          <button type="button" className="admin-btn w-fit" onClick={clear}>Clear</button>
        </div>
      </div>

      <div className="admin-panel p-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="admin-muted text-xs">{query.isLoading ? "Loading…" : `${total} event${total === 1 ? "" : "s"}`}</p>
          <div className="flex items-center gap-2 text-xs">
            <button type="button" className="admin-btn text-[10px]" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</button>
            <span className="admin-muted">Page {page + 1} / {pageCount}</span>
            <button type="button" className="admin-btn text-[10px]" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
        <div className="divide-y divide-[var(--admin-rule)]">
          {items.length === 0 && !query.isLoading && <p className="admin-muted py-6 text-center text-sm">No events match these filters.</p>}
          {items.map((e) => (
            <TraceEventRow key={e.id} event={e} />
          ))}
        </div>
      </div>
    </div>
  );
}
