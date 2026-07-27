"use client";

import Link from "next/link";
import { useSession } from "@/hooks/use-session";
import { Button } from "@/components/ui/button";

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();

  if (isLoading) {
    return <p className="admin-muted text-sm">Loading session…</p>;
  }

  if (!session || session.actorLevel !== "L4") {
    return (
      <div className="admin-panel max-w-lg space-y-4 p-8">
        <h2 className="admin-display text-2xl">L4 authority required</h2>
        <p className="admin-muted text-sm">
          The Admin Console configures hotel parameters. Only L4 administrators may access write surfaces.
        </p>
        <Button variant="outline" asChild>
          <Link href="/desk">Return to operations</Link>
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
