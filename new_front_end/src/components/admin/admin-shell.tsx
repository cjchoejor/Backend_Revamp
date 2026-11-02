"use client";

/**
 * The admin console's frame (2026-11-02, operator: "change the UI of the admin console to match the
 * operation theme"). The desk's own ink bar and palette, with the console's pages in a side list
 * beside the work. A search box at the top of the list finds a page or one setting by its name.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu, X } from "lucide-react";
import { Icon, IconSprite } from "@/design-system";
import {
  activeDomainNumber,
  adminNavGroups,
  overviewNavItem,
  utilityNavItems,
  type AdminNavGroup,
} from "@/config/admin-nav";
import { ROLE_WORD } from "@/components/ds/app-shell";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { settingsIndex } from "@/lib/admin/setting-forms";
import { clockParts } from "@/lib/ds/format";
import { cn } from "@/lib/utils";
import { AdminGuard } from "./admin-guard";

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SideGroup({
  group,
  expanded,
  onToggle,
  pathname,
  onNavigate,
}: {
  group: AdminNavGroup;
  expanded: boolean;
  onToggle: () => void;
  pathname: string;
  onNavigate?: () => void;
}) {
  const GroupIcon = group.icon;
  return (
    <div className="admin-side-group">
      <button type="button" onClick={onToggle} className="admin-side-head" aria-expanded={expanded}>
        <ChevronRight className="admin-side-chev" />
        <GroupIcon />
        <span>{group.title}</span>
      </button>
      {expanded ? (
        <div className="admin-side-items">
          {group.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isItemActive(pathname, item.href) ? "page" : undefined}
              className={cn("admin-sidebar-link", isItemActive(pathname, item.href) && "active")}
            >
              {item.title}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Pages and settings whose words hold what was typed. */
function useFound(query: string) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return null;
    const pages = adminNavGroups
      .flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })))
      .concat(utilityNavItems.map((i) => ({ ...i, group: "Tools" })))
      .filter((i) => `${i.title} ${i.description ?? ""}`.toLowerCase().includes(q))
      .slice(0, 8);
    const settings = settingsIndex()
      .filter((s) => `${s.title} ${s.about}`.toLowerCase().includes(q))
      .slice(0, 12);
    return { pages, settings };
  }, [query]);
}

function SideList({
  pathname,
  expanded,
  setExpanded,
  onNavigate,
}: {
  pathname: string;
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  onNavigate?: () => void;
}) {
  const [query, setQuery] = useState("");
  const found = useFound(query);

  return (
    <>
      <div className="admin-find">
        <input
          type="search"
          className="admin-input"
          placeholder="Find a setting"
          aria-label="Find a page or a setting"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      {found ? (
        <nav aria-label="Found" className="admin-side-items">
          {found.pages.map((p) => (
            <Link key={p.href} href={p.href} onClick={onNavigate} className="admin-sidebar-link found">
              <span>{p.title}</span>
              <small>Page · {p.group}</small>
            </Link>
          ))}
          {found.settings.map((s) => (
            <Link key={s.key} href={`${s.page}?key=${encodeURIComponent(s.key)}`} onClick={onNavigate} className="admin-sidebar-link found">
              <span>{s.title}</span>
              <small>{s.pageTitle}</small>
            </Link>
          ))}
          {found.pages.length + found.settings.length === 0 ? <p className="admin-find-empty">Nothing by that name.</p> : null}
        </nav>
      ) : (
        <nav aria-label="Console">
          <Link
            href={overviewNavItem.href}
            onClick={onNavigate}
            aria-current={isItemActive(pathname, overviewNavItem.href) ? "page" : undefined}
            className={cn("admin-sidebar-link top", isItemActive(pathname, overviewNavItem.href) && "active")}
          >
            {overviewNavItem.title}
          </Link>
          {adminNavGroups.map((group) => (
            <SideGroup
              key={group.domainNumber}
              group={group}
              expanded={expanded === group.domainNumber}
              onToggle={() => setExpanded((cur) => (cur === group.domainNumber ? null : group.domainNumber))}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ))}
          <p className="admin-side-sep">Tools</p>
          {utilityNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isItemActive(pathname, item.href) ? "page" : undefined}
              className={cn("admin-sidebar-link top", isItemActive(pathname, item.href) && "active")}
            >
              {item.title}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

function BarClock() {
  const clock = useHotelClock(1000);
  const { date, time } = clockParts(clock.now, clock.tz, { seconds: true });
  return (
    <span className="clock" title={clock.known ? `Hotel time · ${clock.tz}` : "Hotel time — checking with the server"}>
      <span className="date">{date} · </span>
      <b>{time}</b>
    </span>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session } = useSession();

  // The group holding the page is open; going to a page in another group opens that one.
  const [expanded, setExpanded] = useState<string | null>(() => activeDomainNumber(pathname));
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const next = activeDomainNumber(pathname);
    if (next) setExpanded(next);
  }, [pathname]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const name = session ? session.displayName ?? session.username ?? session.userId : null;

  return (
    <div className="ds" data-ds-overlays>
      <IconSprite />
      <div className="shell theme-blue admin-console">
        <div className="topbar">
          <button type="button" className="admin-menu" aria-label={menuOpen ? "Close the list" : "Open the list"} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <Link href="/admin" className="mark" aria-label="Admin console">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-mark.png" alt="" />
            <span className="name">LEGPHEL PMS</span>
          </Link>
          <span className="admin-zone">Admin console</span>
          <span className="spacer" />
          {session ? (
            <>
              <BarClock />
              <span className="user admin-who" style={{ cursor: "default" }}>
                <Icon name="person" />
                <b>{name}</b>
                <span className="role">{ROLE_WORD[session.actorLevel] ?? session.actorLevel}</span>
              </span>
            </>
          ) : null}
          <Link href="/today" className="admin-back">
            ← Back to the desk
          </Link>
        </div>

        <div className="admin-body">
          <div className={cn("admin-scrim", menuOpen && "open")} onClick={() => setMenuOpen(false)} aria-hidden />
          <aside className={cn("admin-sidebar", menuOpen && "open")}>
            <SideList pathname={pathname} expanded={expanded} setExpanded={setExpanded} onNavigate={() => setMenuOpen(false)} />
          </aside>
          <main className="admin-main">
            <div className="admin-page">
              <AdminGuard>{children}</AdminGuard>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
