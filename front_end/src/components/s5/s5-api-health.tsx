"use client";

import { useEffect, useState } from "react";

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
      <section
        style={{
          border: "1px solid #c62828",
          borderRadius: 8,
          padding: 12,
          background: "#ffebee",
        }}
      >
        <strong>API</strong>: not reachable ({err}). Start the backend on port 4000 (or set{" "}
        <code>BACKEND_URL</code>) and run <code>npm run dev</code> in <code>front_end</code>; Next rewrites{" "}
        <code>/api/*</code> to the backend.
      </section>
    );
  }

  if (!data) {
    return <p style={{ color: "#666" }}>Checking API…</p>;
  }

  return (
    <section
      style={{
        border: "1px solid #2e7d32",
        borderRadius: 8,
        padding: 12,
        background: "#e8f5e9",
      }}
    >
        <strong>API</strong>: {data.ok ? "healthy" : "unknown"}
        {data.scope ? ` (${data.scope})` : ""}
    </section>
  );
}
