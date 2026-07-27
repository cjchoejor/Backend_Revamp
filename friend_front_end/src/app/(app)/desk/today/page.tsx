"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Pause } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listEntries } from "@/lib/api/entries";
import { isLiveStatus, toDeskBooking, type DeskBooking } from "@/lib/desk/model";

const URGENCY_RANK: Record<DeskBooking["timer"]["level"], number> = { crit: 0, warn: 1, "": 2 };

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
  const urgencyOf = (b: DeskBooking) => (b.status === "PARKED" ? 2 : URGENCY_RANK[b.timer.level]);

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

  const stats = useMemo(() => {
    const open = bookings.length;
    const inHouse = bookings.filter((b) => b.step.order >= 7 && b.step.order <= 8).length;
    const needsAttention = bookings.filter((b) => b.status !== "PARKED" && b.timer.level !== "").length;
    const newInquiries = bookings.filter((b) => b.step.order === 1).length;
    return { open, inHouse, needsAttention, newInquiries };
  }, [bookings]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }, []);
  const firstName = (session?.displayName ?? session?.userId ?? "").split(/\s+/)[0] || "there";

  const isLoading = sessionLoading || entriesQuery.isLoading;

  const openBooking = (b: DeskBooking) => router.push(`/desk/bookings/${b.id}`);

  return (
    <section className="view">
      <div className="eyebrow">
        {new Date().toLocaleDateString("en-GB", { weekday: "long" })} at the desk
      </div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        {greeting}, {firstName}.
      </h1>
      <p className="lead">
        {isLoading
          ? "Pulling the desk together…"
          : attention.length === 0
            ? "Nothing is waiting on you right now. New bookings will appear here as they come in."
            : `${attention.length} ${attention.length === 1 ? "booking is" : "bookings are"} moving through the desk. Here's what each needs from you next — the ones sitting longest are first.`}
      </p>

      <div className="today-grid">
        <div className="card">
          <div className="cardhead">
            <div className="sectitle">Needs you next</div>
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
              attention.map((b) => (
                <button key={b.id} className="attn-row" onClick={() => openBooking(b)}>
                  <div className="attn-av" style={{ background: b.avatar }}>
                    {b.initials}
                  </div>
                  <div className="attn-mid">
                    <div className="attn-name">{b.name}</div>
                    <div className="attn-need">{b.need}</div>
                  </div>
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
              ))
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="cardhead">
              <div className="sectitle">The desk right now</div>
            </div>
            <div className="statgrid">
              <div>
                <span className="ms-v mono">{stats.open}</span>
                <span className="ms-k">Open bookings</span>
              </div>
              <div>
                <span className="ms-v mono">{stats.inHouse}</span>
                <span className="ms-k">In-house now</span>
              </div>
              <div>
                <span className="ms-v mono">{stats.needsAttention}</span>
                <span className="ms-k">Sitting too long</span>
              </div>
              <div>
                <span className="ms-v mono">{stats.newInquiries}</span>
                <span className="ms-k">New inquiries</span>
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: "14px 16px" }}>
            <div className="sectitle" style={{ marginBottom: 7 }}>
              A quieter signal
            </div>
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55, margin: 0 }}>
              Each booking carries how long it&rsquo;s been sitting. The chip stays quiet, turning amber after a
              day and red after two — so a stuck booking surfaces itself without the desk ever popping up at you.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
