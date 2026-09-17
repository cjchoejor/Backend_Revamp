"use client";

/**
 * Reports — the honest shapes the booking record supports. Every figure here is a count of
 * bookings the desk already reads; nothing is priced. Occupancy, revenue, ADR, RevPAR and the GST
 * summary need the backend's reporting aggregation (register BE-12, BE-76) and say so.
 */
import { useMemo } from "react";
import { NotAvailableYet } from "@/design-system";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useDeskBookings } from "@/hooks/use-desk-data";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { bookerOfRow } from "@/lib/ds/status";
import { stepNoOfStage } from "@/lib/ds/steps";

function Bar({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="row-acts" style={{ justifyContent: "space-between", gap: 12, flexWrap: "nowrap" }}>
      <span className="meta" style={{ width: 150, flex: "none" }}>
        {label}
      </span>
      <span style={{ flex: 1, background: "var(--surface-2)", borderRadius: 3, height: 14, position: "relative" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: "var(--accent-line)", borderRadius: 3 }} />
      </span>
      <span style={{ width: 110, textAlign: "right", flex: "none" }}>{text}</span>
    </div>
  );
}

export default function ReportsPage() {
  const bookings = useDeskBookings();
  const today = useHotelDay()?.today ?? null;
  const rows = useMemo(() => bookings.data?.items ?? [], [bookings.data]);

  const data = useMemo(() => {
    const kinds: Record<string, number> = { Agent: 0, Corporate: 0, OTA: 0, Direct: 0, "Walk-in": 0 };
    const agents = new Map<string, number>();
    for (const r of rows) {
      const b = bookerOfRow(r);
      const k = b?.kind === "agent" ? "Agent" : b?.kind === "company" ? "Corporate" : b?.kind === "ota" ? "OTA" : b?.kind === "walk-in" ? "Walk-in" : "Direct";
      kinds[k] += 1;
      if (b?.kind === "agent") agents.set(b.name, (agents.get(b.name) ?? 0) + 1);
    }
    const live = (r: (typeof rows)[number]) => r.status !== "CANCELLED";
    const funnel: Array<[string, number]> = [
      ["Inquiries", rows.length],
      ["Quoted", rows.filter((r) => stepNoOfStage(r.currentStage) >= 2 || r.quotations.length > 0).length],
      ["Reserved", rows.filter((r) => live(r) && (stepNoOfStage(r.currentStage) >= 4 || !!r.reservation)).length],
      ["Stayed", rows.filter((r) => live(r) && stepNoOfStage(r.currentStage) >= 7).length],
    ];
    const lost: Array<[string, number]> = [
      ["Outcome never recorded", rows.filter((r) => r.status === "EXPIRED" && !r.noShowDetermination).length],
      ["Cancelled", rows.filter((r) => r.status === "CANCELLED").length],
      ["No-show", rows.filter((r) => !!r.noShowDetermination).length],
      ["No dates on file", rows.filter((r) => r.status === "ACTIVE" && !r.checkInDate).length],
      [
        "Dates passed, open",
        rows.filter((r) => r.status === "ACTIVE" && stepNoOfStage(r.currentStage) <= 2 && !!r.checkInDate && !!today && r.checkInDate.slice(0, 10) < today).length,
      ],
    ];
    const top = [...agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { kinds, funnel, lost, top };
  }, [rows, today]);

  const total = rows.length;
  const kindMax = Math.max(1, ...Object.values(data.kinds));
  const lostMax = Math.max(1, ...data.lost.map(([, n]) => n));
  const topMax = Math.max(1, ...data.top.map(([, n]) => n));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Reports</h2>
          <div className="meta">
            From the booking record · {total} bookings{total >= 500 ? " (the newest 500)" : ""} · counts only — nothing here is priced
          </div>
        </div>
      </div>
      {bookings.error && !bookings.data ? (
        <LoadFailed what="the bookings" onRetry={() => void bookings.refetch()} />
      ) : bookings.isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="grid2" style={{ alignItems: "start", gap: "var(--s6)" }}>
          <section className="block">
            <div className="block-head">
              <h3>Occupancy · rooms sold of rooms available</h3>
            </div>
            <NotAvailableYet what="Rooms sold by month, against the rooms the hotel had," />
          </section>
          <section className="block">
            <div className="block-head">
              <h3>Revenue by month</h3>
            </div>
            <NotAvailableYet what="Revenue, ADR and RevPAR by month" />
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Where the business comes from</h3>
            </div>
            {Object.entries(data.kinds)
              .filter(([, n]) => n > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <Bar key={k} label={k} value={n} max={kindMax} text={`${n} · ${total ? Math.round((n / total) * 100) : 0}%`} />
              ))}
          </section>
          <section className="block">
            <div className="block-head">
              <h3>Inquiry to stay</h3>
            </div>
            {data.funnel.map(([k, n]) => (
              <Bar key={k} label={k} value={n} max={Math.max(1, total)} text={String(n)} />
            ))}
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Demand lost, and why</h3>
            </div>
            {data.lost.map(([k, n]) => (
              <Bar key={k} label={k} value={n} max={lostMax} text={String(n)} />
            ))}
            <p className="meta">Recording a decline with its reason is not in the backend yet, so an inquiry that went elsewhere reads as an outcome never recorded.</p>
          </section>
          <section className="block">
            <div className="block-head">
              <h3>Top agents by bookings</h3>
            </div>
            {data.top.length ? data.top.map(([k, n]) => <Bar key={k} label={k} value={n} max={topMax} text={String(n)} />) : <p className="meta">No agent bookings.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
