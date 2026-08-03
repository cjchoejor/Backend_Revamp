"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { listEntries } from "@/lib/api/entries";
import { listInquiries } from "@/lib/api/inquiries";
import { listRooms } from "@/lib/api/rooms";
import { DESK_STEPS, isLiveStatus, stepForStage } from "@/lib/desk/model";
import { deriveRoomStatus, ROOM_STATUS } from "@/lib/desk/rooms";

type Bar = { label: string; value: number; color: string };

function HBars({ bars, total }: { bars: Bar[]; total: number }) {
  const denom = total || bars.reduce((s, b) => s + b.value, 0) || 1;
  return (
    <>
      {bars.map((b) => {
        const pct = Math.round((b.value / denom) * 100);
        return (
          <div className="hbar" key={b.label}>
            <span className="hl">{b.label}</span>
            <span className="ht">
              <i style={{ width: `${pct}%`, background: b.color }} />
            </span>
            <span className="hv">{b.value}</span>
          </div>
        );
      })}
    </>
  );
}

export default function DeskReportsPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const enabled = !!session && !sessionLoading;

  const roomsQuery = useQuery({ queryKey: ["rooms"], queryFn: () => listRooms(session!), enabled });
  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled,
  });
  const inquiriesQuery = useQuery({
    queryKey: ["inquiries", { limit: 200 }],
    queryFn: () => listInquiries(session!, 200),
    enabled,
  });

  const rooms = useMemo(() => roomsQuery.data?.items ?? [], [roomsQuery.data]);
  const entries = useMemo(() => entriesQuery.data?.items ?? [], [entriesQuery.data]);
  const inquiries = useMemo(() => inquiriesQuery.data?.items ?? [], [inquiriesQuery.data]);

  const isLoading =
    sessionLoading || roomsQuery.isLoading || entriesQuery.isLoading || inquiriesQuery.isLoading;

  const occupancy = useMemo(() => {
    const total = rooms.length;
    const occupied = rooms.filter((r) => deriveRoomStatus(r) === "occupied").length;
    const pct = total ? Math.round((occupied / total) * 100) : 0;
    return { total, occupied, pct };
  }, [rooms]);

  const live = useMemo(() => entries.filter((e) => isLiveStatus(e.status)), [entries]);
  const inHouse = useMemo(
    () => live.filter((e) => stepForStage(e.currentStage).order >= 6 && stepForStage(e.currentStage).order <= 8).length,
    [live],
  );

  const pipelineBars: Bar[] = useMemo(() => {
    const counts = new Map<number, number>();
    live.forEach((e) => {
      const o = stepForStage(e.currentStage).order;
      counts.set(o, (counts.get(o) ?? 0) + 1);
    });
    const palette = ["var(--green)", "var(--green-d)", "var(--epi-system)", "var(--terra)", "var(--warn)"];
    return DESK_STEPS.filter((s) => (counts.get(s.order) ?? 0) > 0).map((s, i) => ({
      label: s.label,
      value: counts.get(s.order) ?? 0,
      color: palette[i % palette.length],
    }));
  }, [live]);

  const channelBars: Bar[] = useMemo(() => {
    const counts = new Map<string, number>();
    inquiries.forEach((q) => {
      const c = (q.sourceChannel ?? "Other").replace(/_/g, " ");
      counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    const palette = ["var(--green)", "var(--epi-system)", "var(--terra)", "var(--warn)", "var(--green-d)"];
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: palette[i % palette.length] }));
  }, [inquiries]);

  const roomStatusBars: Bar[] = useMemo(() => {
    const counts = new Map<string, number>();
    rooms.forEach((r) => {
      const k = deriveRoomStatus(r);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, value]) => ({
        label: ROOM_STATUS[k as keyof typeof ROOM_STATUS].label,
        value,
        color: ROOM_STATUS[k as keyof typeof ROOM_STATUS].color,
      }));
  }, [rooms]);

  const kpis = [
    { label: "Occupancy tonight", value: `${occupancy.pct}%` },
    { label: "Rooms occupied", value: `${occupancy.occupied} / ${occupancy.total}` },
    { label: "Open bookings", value: String(live.length) },
    { label: "In-house now", value: String(inHouse) },
  ];

  return (
    <section className="view">
      <div className="eyebrow">Reports</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        How the property is doing
      </h1>
      <p className="lead">
        Everything here is computed by the system from the live bookings, folios and rooms — figures to read, not
        edit.
      </p>

      {isLoading ? (
        <p className="lead" style={{ marginTop: 18 }}>
          Computing figures…
        </p>
      ) : (
        <>
          <div className="kpibar">
            {kpis.map((k) => (
              <div className="kpi" key={k.label}>
                <div className="kv">{k.value}</div>
                <div className="kk">
                  <span className="axis-mk der" style={{ width: 14, height: 14 }}>
                    ∑
                  </span>
                  {k.label}
                </div>
              </div>
            ))}
          </div>

          <div className="repgrid">
            <div className="card" style={{ padding: "15px 17px" }}>
              <div className="sectitle" style={{ marginBottom: 2 }}>
                Bookings by step
              </div>
              <div className="lead" style={{ fontSize: 12, marginBottom: 10 }}>
                Where the {live.length} open booking{live.length === 1 ? "" : "s"} sit on the journey
              </div>
              {pipelineBars.length ? (
                <HBars bars={pipelineBars} total={live.length} />
              ) : (
                <p className="lead" style={{ fontSize: 12 }}>
                  No open bookings.
                </p>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="card" style={{ padding: "15px 17px" }}>
                <div className="sectitle" style={{ marginBottom: 11 }}>
                  Where inquiries come from
                </div>
                {channelBars.length ? (
                  <HBars bars={channelBars} total={inquiries.length} />
                ) : (
                  <p className="lead" style={{ fontSize: 12 }}>
                    No inquiries yet.
                  </p>
                )}
              </div>
              <div className="card" style={{ padding: "15px 17px" }}>
                <div className="sectitle" style={{ marginBottom: 11 }}>
                  Rooms by status
                </div>
                {roomStatusBars.length ? (
                  <HBars bars={roomStatusBars} total={rooms.length} />
                ) : (
                  <p className="lead" style={{ fontSize: 12 }}>
                    No rooms configured.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div
            className="card"
            style={{ padding: "14px 16px", marginTop: 16, display: "flex", alignItems: "center", gap: 13, flexWrap: "wrap" }}
          >
            <span className="axis-mk sys" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 13 }}>
              ⚙
            </span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="sectitle">Revenue figures aren&rsquo;t wired yet</div>
              <div className="lead" style={{ fontSize: 12 }}>
                Average room rate, RevPAR and the occupancy forecast need a backend reporting aggregation
                (night-audit roll-ups) that isn&rsquo;t exposed to the desk yet. Rather than show invented
                numbers, this page reports only what it can compute live from bookings, inquiries and rooms.
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
