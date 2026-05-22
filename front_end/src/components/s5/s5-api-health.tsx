"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Health = { ok?: boolean; scope?: string };

export function S5ApiHealth() {
  const [data, setData] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Health>;
      })
      .then((j) => {
        if (!cancelled) {
          setData(j);
          setErr(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null);
          setErr(e instanceof Error ? e.message : "Request failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <section className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
        <strong>API</strong>: not reachable ({err}). Start the backend on port 4000 (or set{" "}
        <code className="text-xs">BACKEND_URL</code>) and run <code className="text-xs">npm run dev</code> in{" "}
        <code className="text-xs">front_end</code>.
      </section>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Checking API…</p>;
  }

  return (
    <section
      className={cn(
        "rounded-lg border p-4 text-sm",
        data.ok ? "border-success/40 bg-accent" : "border-muted bg-muted",
      )}
    >
      <strong>API</strong>: {data.ok ? "healthy" : "unknown"}
      {data.scope ? ` (${data.scope})` : ""}
    </section>
  );
}
