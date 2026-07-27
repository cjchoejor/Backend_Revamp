"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  BedDouble,
  Bell,
  CalendarRange,
  Clock,
  LogOut,
  Menu,
  Receipt,
  Settings2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { logoutSession } from "@/lib/api/auth";
import { redirectToLogin } from "@/lib/auth/sign-out";
import { initialsOf } from "@/lib/desk/model";

type DeskNavGroup = "Operations" | "Money" | "System";

type DeskNavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  group: DeskNavGroup;
  /** Minimum actor level required to see this item. Omitted = visible to all. */
  minLevel?: "L1" | "L2" | "L3" | "L4";
};

const DESK_NAV: DeskNavItem[] = [
  { title: "Today", href: "/desk/today", icon: Clock, group: "Operations" },
  { title: "Bookings", href: "/desk/bookings", icon: CalendarRange, group: "Operations" },
  { title: "Rooms", href: "/desk/rooms", icon: BedDouble, group: "Operations" },
  { title: "Billing", href: "/desk/billing", icon: Receipt, group: "Money" },
  { title: "Reports", href: "/desk/reports", icon: BarChart3, group: "Money" },
  // The whole /admin tree (System health included) is L4-gated by AdminGuard.
  { title: "System health", href: "/admin/health", icon: Activity, group: "System", minLevel: "L4" },
  { title: "Admin console", href: "/admin", icon: Settings2, group: "System", minLevel: "L4" },
];

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function meetsLevel(actorLevel: string | undefined, minLevel?: string): boolean {
  if (!minLevel) return true;
  return (LEVEL_RANK[actorLevel ?? ""] ?? 0) >= (LEVEL_RANK[minLevel] ?? 99);
}

const TITLES: Record<string, [string, string]> = {
  "/desk/today": ["Today", "What needs you next"],
  "/desk/bookings": ["Bookings", "Every booking on the desk"],
  "/desk/rooms": ["Rooms", "Status across the property"],
  "/desk/billing": ["Billing", "Folios & balances"],
  "/desk/reports": ["Reports", "How the property is doing"],
};

function titleFor(pathname: string): [string, string] {
  const exact = TITLES[pathname];
  if (exact) return exact;
  const match = Object.entries(TITLES).find(([href]) => pathname.startsWith(`${href}/`));
  return match?.[1] ?? ["Front desk", ""];
}

function DeskClock() {
  const [time, setTime] = useState("--:--");
  const [day, setDay] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
      setDay(d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="clock">
      <span className="cd">{day}</span>
      <span className="ct mono">{time}</span>
    </div>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(".notif-wrap")) setOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open]);
  return (
    <div className="notif-wrap">
      <button
        className="bell"
        aria-label="Notifications"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Bell />
      </button>
      {open && (
        <div className="npanel">
          <div className="npanel-h">
            <div className="t">Notifications</div>
            <div className="s">Only what needs you — routine activity stays off this list.</div>
          </div>
          <div className="nempty">You&rsquo;re all caught up. Deadlines and escalations will surface here.</div>
          <div className="npanel-f">
            Routine actions — posting a charge, readying a room — never land here. Only an escalation, a
            deadline, or a colleague&rsquo;s action that touches your work does.
          </div>
        </div>
      )}
    </div>
  );
}

export function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { session, isLoading, isAuthenticated, clearSession } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [title, subtitle] = titleFor(pathname);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !redirecting) {
      setRedirecting(true);
      void redirectToLogin();
    }
  }, [isLoading, isAuthenticated, redirecting]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  if (isLoading || !session) {
    return (
      <div className="desk-root" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <p className="lead">{redirecting ? "Redirecting to sign in…" : "Loading the desk…"}</p>
      </div>
    );
  }

  const handleLogout = async () => {
    try {
      await logoutSession(session.sessionId);
    } catch {
      /* session may already be invalid */
    }
    await clearSession();
    toast.success("Signed out");
    await redirectToLogin();
  };

  const displayName = session.displayName ?? session.userId;
  const groups: DeskNavGroup[] = ["Operations", "Money", "System"];
  const navFor = (group: DeskNavGroup) =>
    DESK_NAV.filter((n) => n.group === group && meetsLevel(session.actorLevel, n.minLevel));

  return (
    <div className="desk-root app">
      <div className={`backdrop${navOpen ? " on" : ""}`} onClick={() => setNavOpen(false)} />

      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="brand">
          <div className="mk">L</div>
          <div>
            <div className="b1">Legphel</div>
            <div className="b2">Front Desk</div>
          </div>
        </div>
        <nav className="navwrap">
          {groups.map((group) => {
            const items = navFor(group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <div className="navlabel">{group}</div>
                {items.map((n) => {
                  const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
                  const Icon = n.icon;
                  return (
                    <Link key={n.href} href={n.href} className={`nav${active ? " on" : ""}`}>
                      <Icon className="ic" />
                      {n.title}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidefoot">
          <div className="userrow">
            <div className="av">{initialsOf(displayName)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="u1">{displayName}</div>
              <div className="u2">Front desk · {session.actorLevel}</div>
            </div>
            <button className="bell" style={{ width: 30, height: 30 }} aria-label="Sign out" onClick={handleLogout}>
              <LogOut style={{ width: 15, height: 15 }} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="hamb" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            <Menu />
          </button>
          <div>
            <div className="pt1">{title}</div>
            <div className="pt2">{subtitle}</div>
          </div>
          <div className="topspace" />
          <NotificationBell />
          <DeskClock />
        </div>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
