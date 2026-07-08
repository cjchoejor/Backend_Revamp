"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronRight, Menu, X } from "lucide-react";
import {
  activeDomainNumber,
  adminNavGroups,
  overviewNavItem,
  utilityNavItems,
  type AdminNavGroup,
} from "@/config/admin-nav";
import { ZoneTransitionLink } from "@/components/layout/zone-transition";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";
import { AdminGuard } from "./admin-guard";

function isItemActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** One collapsible domain drawer. Header is clickable to toggle. */
function DomainDrawer({
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
  const Icon = group.icon;
  return (
    <div className="admin-sidebar-group">
      <button
        type="button"
        onClick={onToggle}
        className="admin-sidebar-group-header flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">
          <span className="admin-eyebrow mr-1.5 text-[10px] tracking-widest opacity-60">
            {group.domainNumber}
          </span>
          {group.title}
        </span>
      </button>
      {expanded && (
        <div className="admin-sidebar-group-items mt-0.5 space-y-0.5 pl-3">
          {group.items.map((item) => {
            const active = isItemActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn("admin-sidebar-link", active && "active")}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">{item.title}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The nav body shared by the desktop sidebar and the mobile drawer. */
function SidebarNav({
  pathname,
  expandedDomain,
  setExpandedDomain,
  onNavigate,
}: {
  pathname: string;
  expandedDomain: string | null;
  setExpandedDomain: React.Dispatch<React.SetStateAction<string | null>>;
  onNavigate?: () => void;
}) {
  const { session } = useSession();
  const overviewActive = isItemActive(pathname, overviewNavItem.href);

  return (
    <>
      <nav className="space-y-1.5">
        {/* Pinned: Overview */}
        <Link
          href={overviewNavItem.href}
          onClick={onNavigate}
          className={cn("admin-sidebar-link mb-2", overviewActive && "active")}
        >
          <overviewNavItem.icon className="h-4 w-4 shrink-0" />
          {overviewNavItem.title}
        </Link>

        {/* Nine domain drawers */}
        {adminNavGroups.map((group) => (
          <DomainDrawer
            key={group.domainNumber}
            group={group}
            expanded={expandedDomain === group.domainNumber}
            onToggle={() =>
              setExpandedDomain((cur) => (cur === group.domainNumber ? null : group.domainNumber))
            }
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}

        {/* Pinned: Utilities */}
        <div className="mt-4 border-t border-border pt-3">
          <p className="admin-eyebrow mb-1.5 px-2 text-[10px] tracking-widest opacity-60">Utilities</p>
          {utilityNavItems.map((item) => {
            const active = isItemActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn("admin-sidebar-link", active && "active")}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">{item.title}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {session && (
        <div className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{session.displayName ?? session.userId}</p>
          <p>{session.actorLevel} · configuration writes</p>
        </div>
      )}
    </>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Auto-expand the group containing the current page. When you navigate to a page in another
  // domain, that domain expands and the previously-expanded one collapses.
  const [expandedDomain, setExpandedDomain] = useState<string | null>(() => activeDomainNumber(pathname));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const next = activeDomainNumber(pathname);
    if (next) setExpandedDomain(next);
  }, [pathname]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <div className="admin-console flex min-h-screen flex-col bg-background">
      <header className="admin-topnav sticky top-0 z-50 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-4 py-3 md:gap-6 md:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="admin-nav-link -ml-1 flex items-center rounded-md p-1.5 md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="admin-brand shrink-0 border-l-4 border-primary pl-3">
            Admin Console
            <small>LEGPHEL PMS · Configuration</small>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ZoneTransitionLink href="/desk" target="operations" className="admin-nav-link flex items-center gap-1 text-xs">
              <ArrowLeft className="h-3 w-3" />
              Operations
            </ZoneTransitionLink>
          </div>
        </div>
      </header>

      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
          <aside className="admin-sidebar absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col overflow-y-auto border-r border-border bg-card p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="admin-brand border-l-4 border-primary pl-3">
                Admin Console
                <small>Configuration</small>
              </div>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="admin-nav-link rounded-md p-1.5"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarNav
              pathname={pathname}
              expandedDomain={expandedDomain}
              setExpandedDomain={setExpandedDomain}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </aside>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1500px] flex-1 gap-6 px-4 py-6 md:gap-8 md:px-6 lg:px-8">
        <aside className="admin-sidebar sticky top-[84px] hidden max-h-[calc(100vh-104px)] w-60 shrink-0 self-start overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-sm md:block">
          <SidebarNav
            pathname={pathname}
            expandedDomain={expandedDomain}
            setExpandedDomain={setExpandedDomain}
          />
        </aside>

        <main className="min-w-0 flex-1 pb-16">
          <AdminGuard>{children}</AdminGuard>
        </main>
      </div>
    </div>
  );
}
