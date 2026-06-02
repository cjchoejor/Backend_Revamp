"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { adminNav } from "@/config/admin-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { ZoneTransitionLink } from "@/components/layout/zone-transition";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";
import { AdminGuard } from "./admin-guard";

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session } = useSession();

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
        <aside className="admin-sidebar sticky top-[64px] hidden max-h-[calc(100vh-64px)] w-56 shrink-0 overflow-y-auto border-r border-border pr-4 md:block">
          <nav className="space-y-1">
            {adminNav.map((item) => {
              const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn("admin-sidebar-link", active && "active")}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.title}
                </Link>
              );
            })}
          </nav>
          {session && (
            <div className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{session.displayName ?? session.userId}</p>
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
