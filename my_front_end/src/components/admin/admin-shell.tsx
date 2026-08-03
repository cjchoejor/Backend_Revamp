"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import {
  activeDomainNumber,
  adminNavGroups,
  overviewNavItem,
  utilityNavItems,
  type AdminNavGroup,
} from "@/config/admin-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
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
}: {
  group: AdminNavGroup;
  expanded: boolean;
  onToggle: () => void;
  pathname: string;
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

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session } = useSession();

  // Auto-expand the group containing the current page. When you navigate to a page in another
  // domain, that domain expands and the previously-expanded one collapses.
  const [expandedDomain, setExpandedDomain] = useState<string | null>(() => activeDomainNumber(pathname));
  useEffect(() => {
    const next = activeDomainNumber(pathname);
    if (next) setExpandedDomain(next);
  }, [pathname]);

  const overviewActive = isItemActive(pathname, overviewNavItem.href);

  return (
    <div className="admin-console flex min-h-screen flex-col bg-background">
      <header className="admin-topnav sticky top-0 z-50 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-6 px-6 py-3">
          <div className="admin-brand shrink-0 border-l-4 border-primary pl-3">
            Admin Console
            <small>LEGPHEL PMS · Configuration</small>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <ZoneTransitionLink href="/dashboard" target="operations" className="admin-nav-link flex items-center gap-1 text-xs">
              <ArrowLeft className="h-3 w-3" />
              Operations
            </ZoneTransitionLink>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1500px] flex-1 gap-0 px-4 py-6 md:px-6">
        <aside className="admin-sidebar sticky top-[64px] hidden max-h-[calc(100vh-64px)] w-60 shrink-0 overflow-y-auto border-r border-border pr-3 md:block">
          <nav className="space-y-1.5">
            {/* Pinned: Overview */}
            <Link
              href={overviewNavItem.href}
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
              <p className="font-medium text-foreground">{session.displayName ?? session.username ?? session.userId}</p>
              <p>{session.actorLevel} · configuration writes</p>
            </div>
          )}
        </aside>

        <main className="min-w-0 flex-1">
          <AdminGuard>{children}</AdminGuard>
        </main>
      </div>
    </div>
  );
}
