"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, ArrowRight, Clock, LogIn, LogOut, Pause } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listEntries } from "@/lib/api/entries";
import { isLiveStatus, toDeskBooking, type DeskBooking } from "@/lib/desk/model";

const URGENCY_RANK: Record<DeskBooking["timer"]["level"], number> = { crit: 0, warn: 1, "": 2 };

/** How many individual rows the attention list shows before folding into per-step counts. */
const ATTN_LIMIT = 7;

/** Local calendar day as YYYY-MM-DD — entry dates are date-only at UTC midnight, so comparing
 *  the ISO day substring is exact and immune to timezone drift. */
function localTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DeskTodayPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();

  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled: !!session && !sessionLoading,
  });

  const bookings = useMemo(() => {
    const items = entriesQuery.data?.items ?? [];
    return items.map((e) => toDeskBooking(e)).filter((b) => isLiveStatus(b.status));
  }, [entriesQuery.data]);

  // A parked booking is deliberately paused — it shouldn't read as urgent.
  // A due / overdue mid-stay payment (2026-08-22) ranks like a stuck booking of the same level —
  // and ahead of the merely idle ones within it (money waiting beats a booking nobody touched).
  const urgencyOf = (b: DeskBooking) =>
    b.status === "PARKED" ? 2 : Math.min(URGENCY_RANK[b.timer.level], b.alert ? URGENCY_RANK[b.alert.level] - 0.5 : URGENCY_RANK[""]);

  const attention = useMemo(
    () =>
      bookings
        .filter((b) => b.step.order < 9)
        .sort((a, b) => {
          const r = urgencyOf(a) - urgencyOf(b);
          if (r !== 0) return r;
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        }),
    [bookings],
  );

  // Top rows individually; the rest folded into per-step counts so 100 imported bookings at the
  // same step read as ONE line of work, not a wall.
  const shown = attention.slice(0, ATTN_LIMIT);
  const restByStep = useMemo(() => {
    const m = new Map<number, { label: string; count: number }>();
    for (const b of attention.slice(ATTN_LIMIT)) {
      const cur = m.get(b.step.order) ?? { label: b.step.label, count: 0 };
      cur.count += 1;
      m.set(b.step.order, cur);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }, [attention]);

  // The hotel day: who arrives, who leaves, who is in the house — the desk's actual rhythm.
  const todayIso = localTodayIso();
  const isToday = (s?: string | null) => !!s && s.slice(0, 10) === todayIso;
  const arrivals = useMemo(
    () =>
      bookings
        .filter((b) => isToday(b.checkInDate) && b.step.order <= 6)
        .sort((a, b) => b.step.order - a.step.order), // closest to check-in first
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookings, todayIso],
  );
  const departures = useMemo(
    () => bookings.filter((b) => isToday(b.checkOutDate) && b.step.order >= 7 && b.step.order <= 8),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookings, todayIso],
  );

  const stats = useMemo(() => {
    const inHouse = bookings.filter((b) => b.step.order >= 7 && b.step.order <= 8).length;
    const needsAttention = bookings.filter((b) => b.status !== "PARKED" && b.timer.level !== "").length;
    const newInquiries = bookings.filter((b) => b.step.order === 1).length;
    return { inHouse, needsAttention, newInquiries };
  }, [bookings]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }, []);
  // First name for real people; role accounts like "Front Desk 1" keep the full label —
  // "Good evening, Front." read as a bug.
  const rawName = session?.displayName ?? session?.userId ?? "";
  const firstName = /\d/.test(rawName) ? rawName : rawName.split(/\s+/)[0] || "there";

  const isLoading = sessionLoading || entriesQuery.isLoading;

  const openBooking = (b: DeskBooking) => router.push(`/desk/bookings/${b.id}`);

  const miniRow = (b: DeskBooking) => (
    <button key={b.id} className="mini-row" onClick={() => openBooking(b)}>
      <span className="mini-av" style={{ background: b.avatar }}>
        {b.initials}
      </span>
      <span className="mini-mid">
        <span className="mini-name">{b.name}</span>
        <span className="mini-sub">{b.party}</span>
      </span>
      <span className="attn-step">{b.step.label}</span>
    </button>
  );

  return (
    <section className="view">
      <div className="eyebrow">
        {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at the desk
      </div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        {greeting}, {firstName}.
      </h1>
      <p className="lead">
        {isLoading
          ? "Pulling the desk together…"
          : attention.length === 0
            ? "Nothing is waiting on you right now. New bookings will appear here as they come in."
            : `${arrivals.length} arriving · ${departures.length} leaving · ${stats.inHouse} in-house — and ${attention.length} open ${attention.length === 1 ? "booking" : "bookings"} moving through the desk.`}
      </p>

      <div className="today-grid">
        <div className="card">
          <div className="cardhead">
            <div className="sectitle" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              Needs you next
              {stats.needsAttention > 0 && (
                <span className="attn-count">{stats.needsAttention} sitting &gt;1 day</span>
              )}
            </div>
            <Link className="btn btn-ghost btn-sm" href="/desk/bookings">
              All bookings
            </Link>
          </div>
          <div>
            {isLoading ? (
              <div style={{ padding: "26px 16px" }} className="lead">
                Loading bookings…
              </div>
            ) : attention.length === 0 ? (
              <div style={{ padding: "26px 16px" }} className="lead">
                You&rsquo;re all caught up — no booking is waiting on you.
              </div>
            ) : (
              <>
                {shown.map((b) => (
                  <button key={b.id} className="attn-row" onClick={() => openBooking(b)}>
                    <div className="attn-av" style={{ background: b.avatar }}>
                      {b.initials}
                    </div>
                    <div className="attn-mid">
                      <div className="attn-name">{b.name}</div>
                      <div className="attn-need">{b.need}</div>
                      <div className="attn-party">{b.party}</div>
                    </div>
                    {b.alert && b.alert.level && b.status !== "PARKED" && (
                      <span className={`timer ${b.alert.level}`} style={{ gap: 5 }} title={b.alert.need}>
                        <AlarmClock />
                        {b.alert.text}
                      </span>
                    )}
                    {b.status === "PARKED" ? (
                      <span className="timer warn" style={{ gap: 5 }}>
                        <Pause />
                        Parked
                      </span>
                    ) : (
                      <span className={`timer ${b.timer.level}`}>
                        <Clock />
                        {b.timer.text}
                      </span>
                    )}
                    <span className="attn-step">{b.step.label}</span>
                  </button>
                ))}
                {restByStep.length > 0 && (
                  <div className="attn-more">
                    <span>Also moving:</span>
                    {restByStep.map((g) => (
                      <Link key={g.label} href="/desk/bookings" className="attn-pill">
                        {g.label} · {g.count}
                      </Link>
                    ))}
                    <Link href="/desk/bookings" className="attn-alllink">
                      All bookings <ArrowRight />
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="cardhead">
              <div className="sectitle">Today&rsquo;s rhythm</div>
            </div>
            <div className="statgrid">
              <div>
                <span className="ms-v mono">{isLoading ? "…" : arrivals.length}</span>
                <span className="ms-k">Arriving today</span>
              </div>
              <div>
                <span className="ms-v mono">{isLoading ? "…" : departures.length}</span>
                <span className="ms-k">Leaving today</span>
              </div>
              <div>
                <span className="ms-v mono">{isLoading ? "…" : stats.inHouse}</span>
                <span className="ms-k">In-house now</span>
              </div>
              <div>
                <span className="ms-v mono">{isLoading ? "…" : stats.newInquiries}</span>
                <span className="ms-k">New inquiries</span>
              </div>
            </div>
          </div>

          <div className="card" style={{ paddingBottom: 6 }}>
            <div className="mini-h">
              <LogIn /> Arriving today
            </div>
            {isLoading ? null : arrivals.length === 0 ? (
              <p className="mini-empty">No arrivals booked for today.</p>
            ) : (
              <div className="mini-list">
                {arrivals.slice(0, 4).map(miniRow)}
                {arrivals.length > 4 && (
                  <Link className="mini-more" href="/desk/bookings">
                    +{arrivals.length - 4} more <ArrowRight />
                  </Link>
                )}
              </div>
            )}
            <div className="mini-h" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <LogOut /> Leaving today
            </div>
            {isLoading ? null : departures.length === 0 ? (
              <p className="mini-empty">No departures due today.</p>
            ) : (
              <div className="mini-list">
                {departures.slice(0, 4).map(miniRow)}
                {departures.length > 4 && (
                  <Link className="mini-more" href="/desk/billing">
                    +{departures.length - 4} more <ArrowRight />
                  </Link>
                )}
              </div>
            )}
          </div>

          <p className="today-note">
            Idle chips turn amber after a day and red after two — a stuck booking surfaces itself without the
            desk popping up at you.
          </p>
        </div>
      </div>
    </section>
  );
}
