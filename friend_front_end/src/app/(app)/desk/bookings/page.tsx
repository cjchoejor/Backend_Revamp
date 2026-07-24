"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Calendar, Plus } from "lucide-react";
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

/** The date a booking sorts/filters on: its check-in, falling back to when it was created. */
function bookingDate(b: DeskBooking): string {
  return b.checkInDate ?? b.createdAt;
}

/** Today's date as a local `YYYY-MM-DD` string (matches the <input type="date"> value format). */
function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function DeskBookingsPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  // Default the date range to today so the Bookings tab opens on today's bookings (by check-in
  // date). "Clear dates" resets to the full list.
  const [fromDate, setFromDate] = useState(() => todayYmd());
  const [toDate, setToDate] = useState(() => todayYmd());

  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled: !!session && !sessionLoading,
  });

  const bookings = useMemo(
    () => (entriesQuery.data?.items ?? []).map((e) => toDeskBooking(e)),
    [entriesQuery.data],
  );

  // Date-range filter runs on the booking's check-in date (fallback: created date).
  // A `from`/`to` bound is inclusive of that whole day.
  const inDateRange = useMemo(() => {
    const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toMs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
    return (b: DeskBooking) => {
      if (fromMs === null && toMs === null) return true;
      const t = new Date(bookingDate(b)).getTime();
      if (!Number.isFinite(t)) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    };
  }, [fromDate, toDate]);

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const shown = useMemo(
    () =>
      bookings
        .filter((b) => active.test(b) && inDateRange(b))
        // Chronological — earliest check-in (or creation) first.
        .sort((a, b) => new Date(bookingDate(a)).getTime() - new Date(bookingDate(b)).getTime()),
    [bookings, active, inDateRange],
  );

  const dateFilterActive = fromDate !== "" || toDate !== "";
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
          const count = bookings.filter((b) => f.test(b) && inDateRange(b)).length;
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

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 10,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-3)" }}>
          <Calendar style={{ width: 14, height: 14 }} />
          From
          <input
            type="date"
            className="dinput"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            style={{ width: "auto", padding: "6px 9px", fontSize: 13 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-3)" }}>
          To
          <input
            type="date"
            className="dinput"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            style={{ width: "auto", padding: "6px 9px", fontSize: 13 }}
          />
        </label>
        {dateFilterActive && (
          <button
            className="chip-filter"
            onClick={() => {
              setFromDate("");
              setToDate("");
            }}
          >
            Clear dates
          </button>
        )}
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>by check-in date</span>
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
