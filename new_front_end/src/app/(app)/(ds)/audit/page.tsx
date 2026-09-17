"use client";

/**
 * Audit — who did what on one hotel day, read-only. FOM and above: the list names every person's
 * acts across every booking. The full, filterable trail stays in the console.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, Field, Input, Select } from "@/design-system";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { listDeskActivity, listStaffNames } from "@/lib/api/desk";
import { fmtTime } from "@/lib/ds/format";
import { traceWords } from "@/lib/ds/trace-words";
import type { TraceEvent } from "@/lib/trace/humanize";

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export default function AuditPage() {
  const { session, isLoading } = useSession();
  const today = useHotelDay()?.today ?? null;
  const clock = useHotelClock(60_000);
  const [date, setDate] = useState("");
  const [actorId, setActorId] = useState("");
  const [ref, setRef] = useState("");
  const [refQ, setRefQ] = useState("");
  useEffect(() => {
    if (!date && today) setDate(today);
  }, [today, date]);
  useEffect(() => {
    const t = setTimeout(() => setRefQ(ref.trim().toUpperCase()), 300);
    return () => clearTimeout(t);
  }, [ref]);

  const allowed = (RANK[session?.actorLevel ?? "L1"] ?? 1) >= 2;
  const staff = useQuery({
    queryKey: ["desk-staff"],
    queryFn: () => listStaffNames(session!),
    enabled: !!session && !isLoading,
    staleTime: 10 * 60_000,
  });
  const acts = useQuery({
    queryKey: ["desk-activity", date, actorId, refQ],
    queryFn: () => listDeskActivity(session!, { date, actorId: actorId || undefined, entryId: refQ || undefined, limit: 300 }),
    enabled: !!session && !isLoading && allowed && !!date,
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Audit</h2>
          <div className="meta">Who did what · read-only · the desk&apos;s view of operational actions</div>
        </div>
        {allowed ? (
          <div className="row-acts" style={{ alignItems: "flex-end" }}>
            <Field label="Date">
              <Input type="date" value={date} max={today ?? undefined} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Who">
              <Select value={actorId} onChange={(e) => setActorId(e.target.value)}>
                <option value="">Anyone</option>
                {(staff.data?.items ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Booking">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="reference" />
            </Field>
          </div>
        ) : null}
      </div>

      {!allowed ? (
        <EmptyState title="The audit is the FOM's view">It lists every person&apos;s actions across the hotel, so it opens for the FOM, the GM and administrators.</EmptyState>
      ) : acts.error && !acts.data ? (
        <LoadFailed what="the activity" onRetry={() => void acts.refetch()} />
      ) : acts.isLoading || !date ? (
        <LoadingBlock />
      ) : acts.data?.items.length ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th>Action</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {acts.data.items.map((a) => {
                const system = !a.actorName;
                return (
                  <tr key={a.id} className="static">
                    <td className="nowrap">{fmtTime(a.timestamp, clock.tz)}</td>
                    <td>{system ? <span className="ink-2">the system</span> : a.actorName}</td>
                    <td>{traceWords(a as unknown as TraceEvent)}</td>
                    <td className="nowrap">
                      {a.entryId ? (
                        <Link className="row-link" href={`/bookings/${encodeURIComponent(a.entryId)}`}>
                          {a.entryId}
                        </Link>
                      ) : (
                        <span className="dash">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="meta">
            {acts.data.items.length} acts{acts.data.items.length >= 300 ? " · the newest 300 — narrow by person or booking to see the rest" : ""}
          </p>
        </>
      ) : (
        <EmptyState title="Nothing recorded on this day" />
      )}
    </div>
  );
}
