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
        <strong>The server cannot be reached</strong> ({err}). The desk cannot read or save anything until it is back.
      </section>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Checking the server…</p>;
  }

  return (
    <section
      className={cn(
        "rounded-lg border p-4 text-sm",
        data.ok ? "border-[var(--success-line)] bg-[var(--success-soft)]" : "border-[var(--line-2)] bg-[var(--surface-2)]",
      )}
    >
      <strong>{data.ok ? "The server is running" : "The server did not say how it is"}</strong>
    </section>
  );
}
