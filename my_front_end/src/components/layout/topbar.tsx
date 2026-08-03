"use client";

import { LogOut, Lock } from "lucide-react";
import { toast } from "sonner";
import { ThemeToggle } from "./theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-session";
import { lockSession, logoutSession } from "@/lib/api/auth";
import { redirectToLogin } from "@/lib/auth/sign-out";
import type { Session } from "@/types/session";

type TopbarProps = {
  session: Session;
  title?: string;
};

export function Topbar({ session, title = "Operations" }: TopbarProps) {
  const { clearSession } = useSession();

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

  const handleLock = async () => {
    try {
      await lockSession(session.sessionId, session.userId);
      await clearSession();
      toast.info("Session locked");
      await redirectToLogin();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Lock failed");
    }
  };

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card/80 px-6 backdrop-blur">
      <h1 className="font-display text-lg font-semibold tracking-wide">{title}</h1>
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{session.actorLevel}</Badge>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {session.displayName ?? session.username ?? session.userId}
        </span>
        <ThemeToggle />
        <Button variant="ghost" size="icon" onClick={handleLock} aria-label="Lock session">
          <Lock className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
