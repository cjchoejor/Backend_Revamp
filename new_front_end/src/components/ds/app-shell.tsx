"use client";

/**
 * The app shell (Surface Spec 00, locked 10 Sep 2026).
 *
 * One ink bar, always visible: the mark and the product name · the six items in the order of the
 * day (Housekeeping joined after Rooms on 2026-10-26) · the hotel clock · the one notification count · the signed-in person with their role · the
 * overflow that opens the second row. The console sits under the user's name, for administrators
 * only. Panels hang from the control that opened them and close on an outside click, Escape, or
 * the control again.
 */
import { useRefunds } from "@/hooks/use-refunds";
import { useUnseenReplies } from "@/hooks/use-conversation";
import { RefundCoin } from "@/components/ds/refund-bits";
import { money } from "@/lib/ds/format";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Icon, IconSprite, OfflineBanner } from "@/design-system";
import { useSession, redirectToLogin } from "@/hooks/use-session";
import { goToSignIn } from "@/lib/auth/sign-out";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useDeskBookings } from "@/hooks/use-desk-data";
import { useHousekeepingBoard } from "@/hooks/use-housekeeping";
import { lockSession, logoutSession } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { attentionItems, waitingText } from "@/lib/ds/attention";
import { clockParts } from "@/lib/ds/format";

const MAIN = [
  { href: "/today", label: "Today" },
  { href: "/bookings", label: "Bookings" },
  { href: "/rooms", label: "Rooms" },
  { href: "/housekeeping", label: "Housekeeping" },
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

/**
 * The hotel's clock in the topbar, to the second (2026-10-28, operator). It ticks on its own, so the
 * rest of the topbar — the bell's list, the menus — is not drawn again every second.
 */
function TopbarClock() {
  const clock = useHotelClock(1000);
  const { date, time } = clockParts(clock.now, clock.tz, { seconds: true });
  return (
    <span className="clock" title={clock.known ? `Hotel time · ${clock.tz}` : "Hotel time — checking with the server"}>
      <span className="date">{date} · </span>
      <b>{time}</b>
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { session, isLoading, isAuthenticated, clearSession, recheck } = useSession();
  const [redirecting, setRedirecting] = useState(false);
  const clock = useHotelClock(15_000);
  const hotelDay = useHotelDay();
  const bookings = useDeskBookings();
  // Rooms a guest left that are past their clean-by time (2026-10-26) — the bell carries them, since
  // a late room holds up the next guest.
  const housekeeping = useHousekeepingBoard();
  const lateRooms = (housekeeping.data?.rooms ?? []).filter((r) => r.state === "TO_CLEAN" && r.toClean?.overdue);
  // Money to give back, for the FOM, GM and admin (2026-11-05): a row of its own, with the money sign.
  const fom = !!session && session.actorLevel !== "L1";
  const refundsQ = useRefunds("waiting");
  const refundsWaiting = refundsQ.data?.items ?? [];
  // A guest's reply by email nobody has read yet (2026-11-12): a row each, opening the booking's Emails.
  const repliesQ = useUnseenReplies();
  const replies = repliesQ.data?.items ?? [];
  const replyHref = (r: { entryId: string | null }) => (r.entryId ? `/bookings/${encodeURIComponent(r.entryId)}?view=docs&sub=emails` : "/bookings");
  const secondPage = SECOND.some((s) => isOn(pathname, s.href));
  // The six main pages take the stages' blue palette (2026-10-30, operator: "make the theme colour of
  // that page like how we have in the stages UI"); the pages under "more" keep the desk's own.
  // Notifications too (2026-11-10, operator: "notification page to have the ui style like how it is in
  // the other stages and pages").
  const bluePage = MAIN.some((m) => isOn(pathname, m.href)) || isOn(pathname, "/notifications");
  const [secondOpen, setSecondOpen] = useState(false);
  const bell = usePanel();
  const user = usePanel();

  // No sign-in in hand (2026-11-12): look again — the sign-in page may have just written one, or the
  // cookie may hold one — and only then go to sign in, wiping nothing. Deleting the cookie here was
  // what signed people out a moment after they had signed in.
  useEffect(() => {
    if (isLoading || isAuthenticated || redirecting) return;
    let cancelled = false;
    void recheck().then((s) => {
      if (cancelled || s) return;
      setRedirecting(true);
      goToSignIn();
    });
    return () => {
      cancelled = true;
    };
  }, [isLoading, isAuthenticated, redirecting, recheck]);

  // The one coloured count: things that are overdue or due within the next hours.
  const urgent = useMemo(() => {
    const rows = bookings.data?.items ?? [];
    return attentionItems(rows, clock.now, hotelDay?.today ?? null, clock.tz)
      .filter((i) => i.band !== "waiting")
      // A block whose time ended goes to the FOM and GM, first on their list (2026-11-05).
      .filter((i) => fom || !i.critical)
      .sort((a, b) => Number(!!b.critical) - Number(!!a.critical));
    // clock.now moves every 15 s; the list only needs to follow it loosely
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings.data, hotelDay?.today, fom, Math.floor(clock.now / 60_000)]);
  const bellCount = urgent.length + (lateRooms.length ? 1 : 0) + refundsWaiting.length + replies.length;
  // The bell says itself (2026-11-10, operator: "when notifications is there and also arrives, can it
  // show in the ui a little prominently"): the count is red while something is overdue, amber
  // otherwise; and when something new arrives the bell shakes once and a card under it names it.
  const bellOverdue = urgent.some((i) => i.band === "overdue" || i.critical) || lateRooms.length > 0;
  const bellItems = useMemo(
    () => [
      ...urgent.map((i) => ({ key: `a:${i.key}`, text: i.need, who: i.name, href: `/bookings/${i.entryId}` })),
      ...(lateRooms.length
        ? [{ key: "rooms-late", text: `${lateRooms.length === 1 ? `Room ${lateRooms[0].roomNumber}` : `${lateRooms.length} rooms`} past the clean-by time`, who: "Housekeeping", href: "/housekeeping" }]
        : []),
      ...refundsWaiting.map((r) => ({ key: `r:${r.id}`, text: `A refund of ${money(r.amountAsked, r.currency)} to make`, who: r.guest.name ?? r.booking.id, href: `/billing?tab=refunds&refund=${encodeURIComponent(r.id)}` })),
      ...replies.map((r) => ({ key: `m:${r.id}`, text: `${r.fromName ?? r.fromAddress ?? "The guest"} replied by email`, who: r.guest ?? r.referenceNumber, href: replyHref(r) })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urgent, lateRooms.length, refundsWaiting, replies],
  );
  const seenBell = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<{ text: string; who: string; href: string; more: number; at: number } | null>(null);
  // Watching starts once every list the bell reads has come in, so what was already there is not news.
  const bellReady = !!bookings.data && !!hotelDay?.today && !housekeeping.isLoading && !refundsQ.isLoading && !repliesQ.isLoading;
  useEffect(() => {
    if (!bellReady) return;
    const keys = new Set(bellItems.map((x) => x.key));
    const before = seenBell.current;
    seenBell.current = keys;
    if (!before) return; // the first reading is what was already there
    const fresh = bellItems.filter((x) => !before.has(x.key));
    if (fresh.length) setArrived({ text: fresh[0].text, who: fresh[0].who, href: fresh[0].href, more: fresh.length - 1, at: Date.now() });
  }, [bellItems, bellReady]);
  useEffect(() => {
    if (!arrived) return;
    const t = window.setTimeout(() => setArrived(null), 9000);
    return () => window.clearTimeout(t);
  }, [arrived]);

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
    <div className="ds" data-ds-overlays>
      <IconSprite />
      <div className={`shell${bluePage ? " theme-blue" : ""}`}>
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
          <TopbarClock />

          <div ref={bell.ref} style={{ position: "relative" }}>
            <button
              type="button"
              className={`notif${bellCount ? (bellOverdue ? " has overdue" : " has") : ""}${arrived ? " ringing" : ""}`}
              key={arrived?.at ?? "bell"}
              aria-label={`${bellCount} notifications${bellOverdue ? ", something overdue" : ""}`}
              aria-expanded={bell.open}
              onClick={() => {
                setArrived(null);
                bell.setOpen((o) => !o);
              }}
            >
              <Icon name="bell" size="lg" />
              <span className={`count${bellCount === 0 ? " zero" : ""}`}>{bellCount}</span>
            </button>
            {arrived && !bell.open ? (
              <div className="bell-new" role="status" aria-live="polite">
                <span className="bell-new-mark" aria-hidden>
                  <Icon name="bell" />
                </span>
                <span className="bell-new-text">
                  <b>New · {arrived.text}</b>
                  <span className="sm">
                    {arrived.who}
                    {arrived.more > 0 ? ` · and ${arrived.more} more` : ""}
                  </span>
                </span>
                <Link href={arrived.href} className="btn btn-secondary compact" onClick={() => setArrived(null)}>
                  Open
                </Link>
                <button type="button" className="bell-new-x" aria-label="Close" onClick={() => setArrived(null)}>
                  ×
                </button>
              </div>
            ) : null}
            {bell.open ? (
              <div className="drawer open panel-from-bar" role="dialog" aria-label="Notifications">
                {/* The whole list, grouped by kind of work, and the alerts the system sent (2026-10-23) — on
                    the heading row, so it is in view however long the list below runs. */}
                <div className="ntf-head">
                  <h4>What needs a person now</h4>
                  <Link href="/notifications" className="btn btn-secondary compact" onClick={() => bell.setOpen(false)}>
                    See all notifications
                  </Link>
                </div>
                {replies.slice(0, 6).map((r) => (
                  <Link
                    key={r.id}
                    href={replyHref(r)}
                    className="panel-row mail-bell"
                    data-bell-reply={r.id}
                    style={{ marginTop: 8 }}
                    onClick={() => bell.setOpen(false)}
                  >
                    <span className="mail-bell-mark" aria-hidden>
                      <Icon name="send" />
                    </span>
                    <span className="refund-bell-text">
                      <b>Reply from {r.fromName ?? r.fromAddress ?? "the guest"}</b>
                      <span className="sm">
                        {r.subject} · {r.guest ?? r.referenceNumber}
                      </span>
                    </span>
                  </Link>
                ))}
                {replies.length > 6 ? <span className="sm" style={{ display: "block", marginTop: 6 }}>and {replies.length - 6} more replies</span> : null}
                {refundsWaiting.slice(0, 6).map((r) => (
                  <Link
                    key={r.id}
                    href={`/billing?tab=refunds&refund=${encodeURIComponent(r.id)}`}
                    className="panel-row refund-bell"
                    data-bell-refund={r.id}
                    style={{ marginTop: 8 }}
                    onClick={() => bell.setOpen(false)}
                  >
                    <RefundCoin />
                    <span className="refund-bell-text">
                      <b>Refund {money(r.amountAsked, r.currency)}</b>
                      <span className="sm">
                        {r.guest.name ?? r.booking.id} · {r.booking.id}
                      </span>
                    </span>
                  </Link>
                ))}
                {refundsWaiting.length > 6 ? (
                  <Link href="/billing?tab=refunds" className="sm" style={{ display: "block", marginTop: 6 }} onClick={() => bell.setOpen(false)}>
                    and {refundsWaiting.length - 6} more refunds
                  </Link>
                ) : null}
                {lateRooms.length ? (
                  <Link href="/housekeeping" className="panel-row hk-bell" style={{ marginTop: 8 }} onClick={() => bell.setOpen(false)}>
                    <b>{lateRooms.length === 1 ? `Room ${lateRooms[0].roomNumber}` : `Rooms ${lateRooms.map((r) => r.roomNumber).join(", ")}`}</b>
                    <span className="sm">past {lateRooms.length === 1 ? "its" : "their"} clean-by time · housekeeping</span>
                    <span className="timer overdue"><Icon name="alert" />late</span>
                  </Link>
                ) : null}
                {urgent.length === 0 && !lateRooms.length && !refundsWaiting.length && !replies.length ? (
                  <p className="meta" style={{ marginTop: 6 }}>Nothing is overdue or due in the next hours.</p>
                ) : urgent.length === 0 ? null : (
                  <div className="stack" style={{ marginTop: 8 }}>
                    {urgent.slice(0, 20).map((it) => {
                      const w = waitingText(it, clock.now, clock.tz);
                      return (
                        <Link key={it.key} href={`/bookings/${encodeURIComponent(it.entryId)}?step=${it.step}`} className={`panel-row${it.critical ? " crit-bell" : ""}`} data-bell-critical={it.critical ? it.entryId : undefined} onClick={() => bell.setOpen(false)}>
                          <b>
                            {it.critical ? <span className="crit-tag">Critical</span> : null} {it.named ? it.name : <i>{it.name}</i>}
                          </b>
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
                <p className="meta">{role}</p>
                {/* Switch user was Sign out by another name (2026-11-10, operator): one Sign out, a real button. */}
                <div className="stack" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-secondary" onClick={() => void lock()}>
                    <Icon name="lock" />
                    Lock the terminal
                  </button>
                  {session.actorLevel === "L4" ? (
                    <button type="button" className="btn btn-secondary" onClick={() => router.push("/admin")}>
                      The console
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>
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
