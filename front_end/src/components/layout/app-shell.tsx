"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { mainNav } from "@/config/site";
import { useSession } from "@/hooks/use-session";
import { redirectToLogin } from "@/lib/auth/sign-out";
import { Skeleton } from "@/components/ui/skeleton";

function titleFromPath(pathname: string): string {
  const nav = [...mainNav, { title: "Entry", href: "/entries" }, { title: "Health", href: "/admin" }];
  const match = nav.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
  if (pathname.startsWith("/entries/")) return "Entry workspace";
  if (pathname.startsWith("/inquiries/")) return "Inquiry";
  return match?.title ?? "Operations";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = titleFromPath(pathname);
  const { session, isLoading, isAuthenticated } = useSession();
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isRedirecting) {
      setIsRedirecting(true);
      void redirectToLogin();
    }
  }, [isLoading, isAuthenticated, isRedirecting]);

  if (isLoading || !session) {
    return (
      <div className="flex min-h-screen bg-background">
        <Skeleton className="hidden h-screen w-64 shrink-0 lg:block" />
        <div className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-64 w-full" />
          <p className="text-center text-sm text-muted-foreground">
            {isRedirecting ? "Redirecting to sign in…" : "Loading…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <div className="hidden shrink-0 lg:block">
        <Sidebar session={session} />
      </div>
      <div className="flex min-h-screen flex-1 flex-col">
        <Topbar session={session} title={title} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
