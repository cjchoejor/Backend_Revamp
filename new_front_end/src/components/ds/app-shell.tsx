"use client";

/**
 * The app shell (Surface Spec 00, locked 10 Sep 2026).
 *
 * One ink bar, always visible: the mark and the product name · the five items in the order of the
 * day · the hotel clock · the one notification count · the signed-in person with their role · the
 * overflow that opens the second row. The console sits under the user's name, for administrators
 * only. Panels hang from the control that opened them and close on an outside click, Escape, or
 * the control again.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Icon, IconSprite, OfflineBanner } from "@/design-system";
import { useSession, redirectToLogin } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useDeskBookings } from "@/hooks/use-desk-data";
import { lockSession, logoutSession } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { attentionItems, waitingText } from "@/lib/ds/attention";
import { clockParts } from "@/lib/ds/format";

const MAIN = [
  { href: "/today", label: "Today" },
  { href: "/bookings", label: "Bookings" },
  { href: "/rooms", label: "Rooms" },
  { href: "/billing", label: "Billing" },
  { href: "/shift", label: "Shift" },
] as const;

const SECOND = [
  { href: "/reports", label: "Reports" },
  { href: "/guests", label: "Guests" },
  { href: "/handoffs", label: "Handoffs" },
  { href: "/disputes", label: "Disputes" },
  { href: "/messages", label: "Messages" },
  { href: "/audit", label: "Audit" },
] as const;

/** Authority is shown by role, never by a level code (FIG 5.11). */
export const ROLE_WORD: Record<string, string> = { L1: "Front desk", L2: "FOM", L3: "GM", L4: "Administrator" };

function isOn(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function usePanel() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { session, isLoading, isAuthenticated, clearSession } = useSession();
  const [redirecting, setRedirecting] = useState(false);
  const clock = useHotelClock(15_000);
  const hotelDay = useHotelDay();
  const bookings = useDeskBookings();
  const secondPage = SECOND.some((s) => isOn(pathname, s.href));
  const [secondOpen, setSecondOpen] = useState(false);
  const bell = usePanel();
  const user = usePanel();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !redirecting) {
      setRedirecting(true);
      void redirectToLogin();
    }
  }, [isLoading, isAuthenticated, redirecting]);

  // The one coloured count: things that are overdue or due within the next hours.
  const urgent = useMemo(() => {
    const rows = bookings.data?.items ?? [];
    return attentionItems(rows, clock.now, hotelDay?.today ?? null, clock.tz).filter((i) => i.band !== "waiting");
    // clock.now moves every 15 s; the list only needs to follow it loosely
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings.data, hotelDay?.today, Math.floor(clock.now / 60_000)]);

  // Unreachable server (DSS §6): a network failure, not a refusal.
  const offlineSince = useRef<number | null>(null);
  const offline = !!bookings.error && !(bookings.error instanceof ApiError && bookings.error.status > 0);
  if (offline && offlineSince.current == null) offlineSince.current = Date.now();
  if (!offline) offlineSince.current = null;

  if (isLoading || !session) {
    return (
      <div className="ds" style={{ display: "grid", placeItems: "center" }}>
        <IconSprite />
        <p className="meta">{redirecting ? "Taking you to sign in…" : "Opening the desk…"}</p>
      </div>
    );
  }

  const name = session.displayName ?? session.username ?? session.userId;
  const role = ROLE_WORD[session.actorLevel] ?? session.actorLevel;
  const { date, time } = clockParts(clock.now, clock.tz);
  const showSecond = secondPage || secondOpen;

  const signOut = async () => {
    try {
      await logoutSession(session.sessionId);
    } catch {
      /* the session may already be over */
    }
    await clearSession();
    await redirectToLogin();
  };

  const lock = async () => {
    try {
      await lockSession(session.sessionId, session.userId);
      await clearSession();
      toast.success("Terminal locked — sign in to continue.");
      await redirectToLogin();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not lock the terminal");
    }
  };

  return (
    <div className="ds">
      <IconSprite />
      <div className="shell">
        <div className="topbar">
          <Link href="/today" className="mark" aria-label="Today">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-mark.png" alt="" />
            <span className="name">LEGPHEL PMS</span>
          </Link>
          <nav className="nav" aria-label="Main">
            {MAIN.map((m) => (
              <Link key={m.href} href={m.href} aria-current={isOn(pathname, m.href) ? "page" : undefined}>
                {m.label}
              </Link>
            ))}
          </nav>
          <span className="spacer" />
          <span className="clock" title={clock.known ? `Hotel time · ${clock.tz}` : "Hotel time — checking with the server"}>
            <span className="date">{date} · </span>
            <b>{time}</b>
          </span>

          <div ref={bell.ref} style={{ position: "relative" }}>
            <button type="button" className="notif" aria-label={`${urgent.length} notifications`} aria-expanded={bell.open} onClick={() => bell.setOpen((o) => !o)}>
              <Icon name="bell" size="lg" />
              <span className={`count${urgent.length === 0 ? " zero" : ""}`}>{urgent.length}</span>
            </button>
            {bell.open ? (
              <div className="drawer open panel-from-bar" role="dialog" aria-label="Notifications">
                <h4>What needs a person now</h4>
                {urgent.length === 0 ? (
                  <p className="meta" style={{ marginTop: 6 }}>Nothing is overdue or due in the next hours.</p>
                ) : (
                  <div className="stack" style={{ marginTop: 8 }}>
                    {urgent.slice(0, 20).map((it) => {
                      const w = waitingText(it, clock.now, clock.tz);
                      return (
                        <Link key={it.key} href={`/bookings/${encodeURIComponent(it.entryId)}?step=${it.step}`} className="panel-row" onClick={() => bell.setOpen(false)}>
                          <b>{it.named ? it.name : <i>{it.name}</i>}</b>
                          <span className="sm">{it.need}</span>
                          {w.text ? <span className={`timer ${w.tone}`}><Icon name={w.tone === "overdue" ? "alert" : "clock"} />{w.text}</span> : null}
                        </Link>
                      );
                    })}
                  </div>
                )}
                <p className="meta" style={{ marginTop: 10 }}>Routine work never lands here — only what is overdue or due within the next hours.</p>
              </div>
            ) : null}
          </div>

          <div ref={user.ref} style={{ position: "relative" }}>
            <button type="button" className="user" aria-expanded={user.open} onClick={() => user.setOpen((o) => !o)}>
              <Icon name="person" />
              <b>{name}</b>
              <span className="role">{role}</span>
              <Icon name="chev" />
            </button>
            {user.open ? (
              <div className="drawer open panel-from-bar" role="dialog" aria-label="Signed in">
                <h4>{name}</h4>
                <p className="meta">{role} · terminal {session.terminalId}</p>
                <div className="stack" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>
                    Switch user
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void lock()}>
                    <Icon name="lock" />
                    Lock the terminal
                  </button>
                  {session.actorLevel === "L4" ? (
                    <button type="button" className="btn btn-secondary" onClick={() => router.push("/admin")}>
                      The console
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-quiet" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <button type="button" className="btn btn-quiet icon-only" aria-label="More" aria-expanded={showSecond} onClick={() => setSecondOpen((o) => !o)}>
            <Icon name="more" />
          </button>
        </div>
        {showSecond ? (
          <div className="subrow">
            {SECOND.map((s) => (
              <Link key={s.href} href={s.href} aria-current={isOn(pathname, s.href) ? "page" : undefined}>
                {s.label}
              </Link>
            ))}
          </div>
        ) : null}
        {offline ? (
          <div style={{ padding: "12px 24px 0" }}>
            <OfflineBanner
              since={new Date(offlineSince.current ?? Date.now()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              onCheck={() => void bookings.refetch()}
            />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
