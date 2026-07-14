"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Logo } from "@/components/brand/logo";
import { mainNav, secondaryNav } from "@/config/site";
import { cn } from "@/lib/utils";
import { ZoneTransitionLink } from "@/components/layout/zone-transition";
import type { Session } from "@/types/session";

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function canAccess(level: Session["actorLevel"], minLevel?: string) {
  if (!minLevel) return true;
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

export function Sidebar({ session }: { session: Session }) {
  const pathname = usePathname();

  const linkClass = (href: string) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      pathname === href || pathname.startsWith(`${href}/`)
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      <div className="flex items-center justify-center border-b px-4 py-5">
        <Logo width={140} height={80} />
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {mainNav.map((item) => (
          <Link key={item.href} href={item.href} className={linkClass(item.href)}>
            <item.icon className="h-4 w-4 shrink-0" />
            {item.title}
            {pathname === item.href && (
              <motion.span layoutId="nav-indicator" className="ml-auto h-1.5 w-1.5 rounded-full bg-primary-foreground" />
            )}
          </Link>
        ))}
        <div className="my-4 h-px bg-border" />
        {secondaryNav
          .filter((item) => canAccess(session.actorLevel, item.minLevel))
          .map((item) => {
            // Cross-zone links into Admin trigger the transition overlay so the page change is not abrupt.
            const isCrossZone = item.href === "/admin" || item.href.startsWith("/admin?");
            const content = (
              <>
                <item.icon className="h-4 w-4 shrink-0" />
                {item.title}
              </>
            );
            return isCrossZone ? (
              <ZoneTransitionLink key={item.href} href={item.href} target="admin" className={linkClass(item.href)}>
                {content}
              </ZoneTransitionLink>
            ) : (
              <Link key={item.href} href={item.href} className={linkClass(item.href)}>
                {content}
              </Link>
            );
          })}
      </nav>
      <div className="border-t p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{session.displayName ?? session.username ?? session.userId}</p>
        <p>{session.actorLevel} · {session.terminalId}</p>
      </div>
    </aside>
  );
}
