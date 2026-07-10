"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listEntries } from "@/lib/api/entries";
import { DESK_STEPS, toDeskBooking, type DeskBooking } from "@/lib/desk/model";

type Filter = { key: string; label: string; test: (b: DeskBooking) => boolean };

const FILTERS: Filter[] = [
  { key: "all", label: "All", test: () => true },
  // The live-phase views exclude terminally-expired bookings so a lapsed entry doesn't show up as
  // "Being shaped" etc. — expired has its own group below (next to Closed).
  { key: "shaping", label: "Being shaped", test: (b) => b.status !== "EXPIRED" && b.step.order <= 3 },
  { key: "confirmed", label: "Confirmed", test: (b) => b.status !== "EXPIRED" && b.step.order >= 4 && b.step.order <= 5 },
  { key: "inhouse", label: "In-house", test: (b) => b.status !== "EXPIRED" && b.step.order >= 6 && b.step.order <= 8 },
  { key: "closed", label: "Closed", test: (b) => b.status !== "EXPIRED" && b.step.order === 9 },
  { key: "expired", label: "Expired", test: (b) => b.status === "EXPIRED" },
];

export default function DeskBookingsPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();
  const [filter, setFilter] = useState("all");

  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled: !!session && !sessionLoading,
  });

  const bookings = useMemo(
    () => (entriesQuery.data?.items ?? []).map((e) => toDeskBooking(e)),
    [entriesQuery.data],
  );

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const shown = useMemo(
    () => bookings.filter(active.test).sort((a, b) => a.step.order - b.step.order),
    [bookings, active],
  );

  const isLoading = sessionLoading || entriesQuery.isLoading;

  return (
    <section className="view">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Bookings</div>
          <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
            Every booking on the desk
          </h1>
          <p className="lead">
            Who they are, how far they&rsquo;ve come, and what each needs next. Open one to work it.
          </p>
        </div>
        <Link className="btn btn-primary" href="/desk/bookings/new">
          <Plus />
          New booking
        </Link>
      </div>

      <div className="eng-filter">
        {FILTERS.map((f) => {
          const count = bookings.filter(f.test).length;
          return (
            <button
              key={f.key}
              className={`chip-filter${filter === f.key ? " on" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {!isLoading && ` · ${count}`}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="lead" style={{ marginTop: 18 }}>
          Loading bookings…
        </p>
      ) : shown.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            No bookings in this view.
          </p>
        </div>
      ) : (
        <div className="eng-grid">
          {shown.map((b) => (
            <button
              key={b.id}
              className="eng-card"
              onClick={() => router.push(`/desk/bookings/${b.id}`)}
            >
              <div className="ec-top">
                <div className="ec-av" style={{ background: b.avatar }}>
                  {b.initials}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="ec-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {b.name}
                    {b.status === "PARKED" && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: 0.3,
                          textTransform: "uppercase",
                          color: "var(--warn)",
                          background: "var(--warn-t)",
                          border: "1px solid #e6cf9a",
                          borderRadius: 6,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Parked
                      </span>
                    )}
                    {b.status === "EXPIRED" && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: 0.3,
                          textTransform: "uppercase",
                          color: "#6c7169",
                          background: "#e9e7e0",
                          border: "1px solid var(--line-2)",
                          borderRadius: 6,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Expired
                      </span>
                    )}
                  </div>
                  <div className="ec-sub mono">{b.party}</div>
                </div>
              </div>
              <div className="ec-track">
                {DESK_STEPS.map((s) => {
                  const cls = s.order < b.step.order ? "done" : s.order === b.step.order ? "cur" : "";
                  return <div key={s.order} className={`ec-pip ${cls}`} />;
                })}
              </div>
              <div className="ec-foot">
                <span className="ec-need">
                  {b.step.label} · {b.status === "EXPIRED" ? "no longer active" : b.need}
                </span>
                <span className="ec-open">
                  Open
                  <ArrowRight style={{ width: 12, height: 12 }} />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
